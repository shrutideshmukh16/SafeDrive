"""
SafeDrive backend (Flask)
=========================
What this server does
  1. Receives sensor + GPS data from the ESP32-S3 (POST /api/device/event).
  2. Runs the accident-detection limit check (is_accident).
  3. If an accident is suspected it opens a CONFIRMATION WINDOW (default 60 s,
     configurable 15-180 s). During that window the owner can answer
       "I am safe"  -> alert is cancelled, nobody is notified (false alarm)
       "I need help"-> alert is sent immediately
     If there is no answer when the timer ends, the alert is sent automatically.
  4. Sending the alert = queueing SMS + call commands for the SIM7672G GSM
     module (through Firebase) for every saved family contact.
  5. Stores profile, contacts, settings and history in a JSON model, and
     mirrors it to Firebase Realtime Database when credentials are provided.

Run
  pip install -r requirements.txt
  python app.py                      # http://localhost:5000

Optional Firebase (environment variables)
  FIREBASE_CRED   path to the service-account JSON file
  FIREBASE_DB_URL e.g. https://your-project-default-rtdb.firebaseio.com
"""
import copy
import json
import os
import re
import threading
import time
import uuid

from flask import Flask, jsonify, request

try:  # flask-cors is optional: without it we add the CORS headers ourselves
    from flask_cors import CORS
except ImportError:  # pragma: no cover
    CORS = None

try:  # Firebase is optional - the server also works with only the JSON file
    import firebase_admin
    from firebase_admin import credentials, db as fb_db
except ImportError:  # pragma: no cover
    firebase_admin = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_FILE = os.path.join(BASE_DIR, "data_model.json")
DATA_DIR = os.environ.get("SAFEDRIVE_DATA_DIR", os.path.join(BASE_DIR, "data"))
STORE_FILE = os.path.join(DATA_DIR, "store.json")

# ---- Accident limits (tune these after testing with the real sensor) ----
ACCEL_LIMIT_G = float(os.environ.get("ACCEL_LIMIT_G", "4.0"))    # sudden impact
TILT_LIMIT_DEG = float(os.environ.get("TILT_LIMIT_DEG", "60"))   # rollover / abnormal tilt
VIBRATION_LIMIT = float(os.environ.get("VIBRATION_LIMIT", "0.7"))  # 0..1 from vibration sensor

PHONE_RE = re.compile(r"^\+?[0-9]{10,13}$")
MAX_CONTACTS = 10
SETTING_KEYS = {"confirm_seconds", "notify_sms", "notify_call", "notify_push", "theme", "accent"}
PROFILE_KEYS = {"name", "phone", "vehicle_name", "vehicle_number", "vehicle_model"}


# =====================================================================
# Detection logic
# =====================================================================
def is_accident(accel_g, tilt_deg, vibration):
    """A strong impact AND at least one more sign (tilt or vibration spike).
    Requiring two signals avoids false alarms from potholes or hard braking."""
    strong_impact = accel_g >= ACCEL_LIMIT_G
    confirmed_by = tilt_deg >= TILT_LIMIT_DEG or vibration >= VIBRATION_LIMIT
    return strong_impact and confirmed_by


# =====================================================================
# Storage: JSON file (+ Firebase mirror)
# =====================================================================
class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.firebase = False
        self._init_firebase()
        with open(MODEL_FILE, "r", encoding="utf-8") as f:
            self.default = json.load(f)["default"]
        os.makedirs(DATA_DIR, exist_ok=True)
        if os.path.exists(STORE_FILE):
            with open(STORE_FILE, "r", encoding="utf-8") as f:
                self.data = json.load(f)
        else:
            self.data = copy.deepcopy(self.default)
            self._write_file()
        self.data.setdefault("history", [])
        self.last_location = {"lat": 18.5204, "lng": 73.8567}

    def _init_firebase(self):
        cred_path, db_url = os.environ.get("FIREBASE_CRED"), os.environ.get("FIREBASE_DB_URL")
        if firebase_admin and cred_path and db_url and os.path.exists(cred_path):
            try:
                firebase_admin.initialize_app(credentials.Certificate(cred_path), {"databaseURL": db_url})
                self.firebase = True
                print("[firebase] connected")
            except Exception as exc:  # noqa: BLE001
                print("[firebase] could not start:", exc)

    def _write_file(self):
        tmp = STORE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2)
        os.replace(tmp, STORE_FILE)

    def save(self):
        with self.lock:
            self._write_file()
            if self.firebase:
                try:
                    fb_db.reference("/safedrive").set(self.data)
                except Exception as exc:  # noqa: BLE001
                    print("[firebase] sync failed:", exc)

    def push_command(self, command):
        """Queue a command that the ESP32 / SIM7672G listens for."""
        if self.firebase:
            try:
                fb_db.reference("/gsm_commands").push(command)
                return
            except Exception as exc:  # noqa: BLE001
                print("[firebase] command failed:", exc)
        print("[gsm-command]", json.dumps(command))


store = Store()


# =====================================================================
# Confirmation window + alert dispatch
# =====================================================================
def maps_link(lat, lng):
    return "https://www.google.com/maps?q={:.6f},{:.6f}".format(lat, lng)


class Monitor:
    """Owns the one active event and its countdown timer."""

    def __init__(self):
        self.lock = threading.RLock()
        self.event = None       # active event (pending or alert_sent, until resolved)
        self.deadline = 0.0
        self.timer = None

    # ---- read ----
    def status(self):
        with self.lock:
            if not self.event:
                return "safe"
            return "confirming" if self.event["outcome"] == "pending" else "accident"

    def seconds_left(self):
        with self.lock:
            if self.event and self.event["outcome"] == "pending":
                return max(0, int(round(self.deadline - time.time())))
            return 0

    # ---- events ----
    def open_event(self, lat, lng, peak_g, tilt):
        with self.lock:
            if self.event:  # already handling one
                return self.event, False
            seconds = store.data["settings"].get("confirm_seconds", 60)
            self.event = {
                "id": "ev_" + uuid.uuid4().hex[:8], "time": int(time.time() * 1000),
                "lat": lat, "lng": lng, "peak_g": round(peak_g, 1), "tilt": round(tilt),
                "outcome": "pending", "reason": "", "alerts": [],
            }
            self.deadline = time.time() + seconds
            self.timer = threading.Timer(seconds, self._on_timeout, args=(self.event["id"],))
            self.timer.daemon = True
            self.timer.start()
            print("[event] opened", self.event["id"], "- waiting", seconds, "s for owner")
            return self.event, True

    def respond(self, event_id, response):
        with self.lock:
            ev = self.event
            if not ev or ev["id"] != event_id or ev["outcome"] != "pending":
                raise ValueError("No pending event with that id")
            if self.timer:
                self.timer.cancel()
            if response == "safe":
                ev["outcome"], ev["reason"] = "false_alarm", "owner_safe"
                self._archive(ev)
                self.event = None
                print("[event] owner is safe - alert cancelled")
            elif response == "help":
                self._escalate("driver_needs_help")
            else:
                raise ValueError("response must be 'safe' or 'help'")

    def resolve(self):
        """Owner / admin clears an active accident state."""
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self.event = None

    def _on_timeout(self, event_id):
        with self.lock:
            if self.event and self.event["id"] == event_id and self.event["outcome"] == "pending":
                self._escalate("no_response")

    def _escalate(self, reason):
        ev = self.event
        st = store.data
        s = st["settings"]
        channels = [c for c, on in (("SMS", s.get("notify_sms")), ("Call", s.get("notify_call")),
                                    ("App", s.get("notify_push"))) if on]
        p = st["profile"]
        text = ("EMERGENCY: {} may have met with an accident in {} ({}). "
                "Live location: {}").format(p["name"], p["vehicle_name"], p["vehicle_number"],
                                            maps_link(ev["lat"], ev["lng"]))
        ev["alerts"] = []
        for c in st["contacts"]:
            for ch in channels:
                store.push_command({"type": ch.lower(), "to": c["phone"], "text": text,
                                    "event_id": ev["id"], "time": int(time.time() * 1000)})
            ev["alerts"].append({"name": c["name"], "phone": c["phone"], "channels": list(channels)})
        ev["outcome"], ev["reason"] = "alert_sent", reason
        self._archive(ev)
        print("[event] ALERT SENT to", len(st["contacts"]), "contact(s) -", reason)

    @staticmethod
    def _archive(ev):
        with store.lock:
            store.data["history"].insert(0, copy.deepcopy(ev))
            store.data["history"] = store.data["history"][:200]
            store.save()


monitor = Monitor()


# =====================================================================
# Flask API
# =====================================================================
app = Flask(__name__)
if CORS:
    CORS(app)  # lets the website / app call this server from another address
else:
    @app.after_request
    def add_cors_headers(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        return resp


def err(message, code=400):
    return jsonify({"error": message}), code


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "firebase": store.firebase})


@app.get("/api/state")
def get_state():
    with store.lock:
        d = store.data
        return jsonify({"profile": d["profile"], "contacts": d["contacts"],
                        "settings": d["settings"], "history": d["history"]})


# ---------- profile ----------
@app.put("/api/profile")
def update_profile():
    body = request.get_json(silent=True) or {}
    clean = {k: str(v).strip() for k, v in body.items() if k in PROFILE_KEYS}
    if "name" in clean and not clean["name"]:
        return err("Name is required")
    if "phone" in clean and not PHONE_RE.match(clean["phone"]):
        return err("Invalid phone number")
    with store.lock:
        store.data["profile"].update(clean)
        store.save()
        return jsonify(store.data["profile"])


# ---------- contacts ----------
@app.get("/api/contacts")
def list_contacts():
    return jsonify(store.data["contacts"])


@app.post("/api/contacts")
def add_contact():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    phone = re.sub(r"[\s\-()]", "", str(body.get("phone", "")))
    if not name:
        return err("Name is required")
    if not PHONE_RE.match(phone):
        return err("Invalid phone number")
    with store.lock:
        contacts = store.data["contacts"]
        if len(contacts) >= MAX_CONTACTS:
            return err("Contact limit reached (%d)" % MAX_CONTACTS)
        if any(c["phone"] == phone for c in contacts):
            return err("This number is already linked")
        contact = {"id": "c_" + uuid.uuid4().hex[:8], "name": name,
                   "relation": str(body.get("relation") or "Family").strip(),
                   "phone": phone, "primary": len(contacts) == 0}
        contacts.append(contact)
        store.save()
        return jsonify(contact), 201


@app.delete("/api/contacts/<cid>")
def delete_contact(cid):
    with store.lock:
        contacts = store.data["contacts"]
        target = next((c for c in contacts if c["id"] == cid), None)
        if not target:
            return err("Contact not found", 404)
        contacts.remove(target)
        if target.get("primary") and contacts:
            contacts[0]["primary"] = True
        store.save()
        return jsonify({"deleted": cid})


@app.put("/api/contacts/<cid>/primary")
def make_primary(cid):
    with store.lock:
        contacts = store.data["contacts"]
        if not any(c["id"] == cid for c in contacts):
            return err("Contact not found", 404)
        for c in contacts:
            c["primary"] = c["id"] == cid
        store.save()
        return jsonify(contacts)


# ---------- settings ----------
@app.put("/api/settings")
def update_settings():
    body = request.get_json(silent=True) or {}
    clean = {k: v for k, v in body.items() if k in SETTING_KEYS}
    if "confirm_seconds" in clean:
        try:
            clean["confirm_seconds"] = max(15, min(180, int(clean["confirm_seconds"])))
        except (TypeError, ValueError):
            return err("confirm_seconds must be a number")
    for key in ("notify_sms", "notify_call", "notify_push"):
        if key in clean:
            clean[key] = bool(clean[key])
    if clean.get("theme") not in (None, "auto", "light", "dark"):
        return err("theme must be auto, light or dark")
    if "accent" in clean and not re.match(r"^#[0-9a-fA-F]{6}$", str(clean["accent"])):
        return err("accent must be a hex colour like #2563eb")
    with store.lock:
        store.data["settings"].update(clean)
        store.save()
        return jsonify(store.data["settings"])


# ---------- device (ESP32-S3) ----------
@app.post("/api/device/event")
def device_event():
    """ESP32 posts readings. Example body:
    {"device_id":"esp32-01","accel_g":6.2,"tilt_deg":72,"vibration":0.9,"lat":18.52,"lng":73.85}"""
    b = request.get_json(silent=True) or {}
    try:
        g, tilt, vib = float(b.get("accel_g", 0)), float(b.get("tilt_deg", 0)), float(b.get("vibration", 0))
        lat, lng = float(b["lat"]), float(b["lng"])
    except (KeyError, TypeError, ValueError):
        return err("accel_g, tilt_deg, vibration, lat and lng must be numbers")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return err("Invalid GPS coordinates")
    store.last_location = {"lat": lat, "lng": lng}
    if not is_accident(g, tilt, vib):
        return jsonify({"detected": False, "status": monitor.status()})
    event, created = monitor.open_event(lat, lng, g, tilt)
    return jsonify({"detected": True, "new": created, "event": event}), 201 if created else 200


@app.get("/api/status")
def get_status():
    with monitor.lock:
        ev = monitor.event
        return jsonify({"status": monitor.status(), "event": ev, "seconds_left": monitor.seconds_left(),
                        "location": ev and {"lat": ev["lat"], "lng": ev["lng"]} or store.last_location})


@app.post("/api/event/<event_id>/respond")
def respond(event_id):
    answer = (request.get_json(silent=True) or {}).get("response")
    try:
        monitor.respond(event_id, answer)
    except ValueError as exc:
        return err(str(exc), 404 if "No pending" in str(exc) else 400)
    return jsonify({"status": monitor.status()})


@app.post("/api/event/resolve")
def resolve():
    monitor.resolve()
    return jsonify({"status": monitor.status()})


@app.get("/api/history")
def history():
    return jsonify(store.data["history"])


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    # threaded=True so the countdown timer and API requests run side by side
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)

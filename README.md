# SafeDrive - Vehicle Accident Detection & Alert System

```
safedrive/
  frontend/   index.html, style.css, app.js   (website dashboard)
  backend/    app.py, data_model.json, requirements.txt   (Python + Flask)
  mobile/     App.js   (React Native version of the same dashboard)
```

## 1. Run the website only (demo mode, no server)
Open `frontend/index.html` in VS Code with the **Live Server** extension (or just double-click it).
Click **Simulate crash** to see the confirmation countdown, then try:
- **I am safe** -> alert cancelled, nobody notified (logged as false alarm)
- **I need help** or wait for the timer -> alert sent to every saved contact

## 2. Run the Python backend
```
cd backend
pip install -r requirements.txt
python app.py            # http://localhost:5000
```
Then in the website go to **Settings -> Backend connection**, enter `http://localhost:5000`
and press **Connect**. The countdown is now controlled by the server.

Test the ESP32 path without hardware:
```
curl -X POST http://localhost:5000/api/device/event -H "Content-Type: application/json" \
  -d '{"device_id":"esp32-01","accel_g":6.2,"tilt_deg":72,"vibration":0.9,"lat":18.52,"lng":73.85}'
```

## 3. Firebase (optional)
```
set FIREBASE_CRED=serviceAccountKey.json
set FIREBASE_DB_URL=https://your-project-default-rtdb.firebaseio.com
python app.py
```
The JSON model is mirrored to `/safedrive`; SMS/call commands are pushed to `/gsm_commands`
for the ESP32 + SIM7672G to read and execute.

## 4. Mobile app
See the setup notes at the top of `mobile/App.js`. Set `API_URL` to your computer's local IP.

## Accident limits (backend/app.py)
Accident = acceleration >= 4 g **and** (tilt >= 60 deg **or** vibration >= 0.7).
Two signals are required so potholes and hard braking do not trigger false alarms.

# Wayfinder - iPhone obstacle warning + voice navigation

Wayfinder is a local-first companion pipeline for a user who is walking with an iPhone. It captures the **rear iPhone camera** in Safari, uploads one JPEG every two seconds to a local vision service, sounds an attention tone and vibration when an obstacle is likely close, and turns a spoken destination into **live, spoken in-app walking guidance**.

> Safety note: this is an assistive warning system, not a replacement for a cane, guide dog, orientation training, attention, or a mobility aid. Computer vision can miss curbs, glass, low-hanging objects, traffic, and changing hazards. Do not use it as the sole basis for crossing streets or avoiding hazards.

## What is included

```text
iPhone Safari / PWA
  rear camera -> JPEG every 2 seconds -> FastAPI /api/detect -> YOLO (local)
  speech destination -> nearest OSM place -> pedestrian route -> live spoken GPS maneuvers
  obstacle event -> on-device alarm + vibration + accessible spoken warning
```

- Camera permission, two-second snapshot cadence, and live preview
- Local YOLO object detection with conservative proximity scoring
- Audible warning, vibration, flash, and speech output on the iPhone
- Voice destination capture using Safari Web Speech when available, with a typed fallback
- In-app OpenStreetMap pedestrian directions without API keys or an agent service
- Automatic nearest-match selection and continuous GPS-triggered speech
- A local-only development mode so the camera alert UI can be tested without keys or a model

## Prerequisites

- Python 3.11+
- An iPhone and a computer on the same network

## Run it

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://<your-computer-LAN-IP>:8000` on the iPhone. For camera access, Safari requires a secure context except for `localhost`. Use an HTTPS tunnel or put the service behind a local HTTPS reverse proxy; see [iPhone access](#iphone-access). Start with the **Enable alerts** button before testing: iOS only permits audio after an explicit user gesture.

## iPhone access

For development, expose the service with an HTTPS URL, then open that URL in Safari:

```powershell
npx localtunnel --port 8000
```

For a deployment, use a trusted HTTPS reverse proxy on your private network. Treat camera images and API keys as sensitive. Do not expose this app to the public Internet without authentication, TLS, rate limiting, and a review of retention/access policies.

### Alert behavior on iOS

The PWA creates a short Web Audio alarm and requests vibration where the browser permits it. It cannot force the phone's OS-level ringer or bypass Silent Mode/Focus. A production build needing guaranteed hardware-level alerts should wrap this UI in a native iOS app (for example, Capacitor) and use native haptics/audio with the appropriate user permissions.

## Keyless in-app navigation

Wayfinder sends one user-triggered place query through the server to OpenStreetMap Nominatim, ranks the returned matches by straight-line distance from the phone, and automatically chooses the nearest. It requests a pedestrian route from the FOSSGIS-hosted OSRM foot profile, then keeps navigation inside the UI. The browser watches GPS, updates the next maneuver distance, and speaks instructions near 120 m, 60 m, and the turn.

The public services are appropriate for personal and demo use, not a high-traffic production deployment. Nominatim requests are serialized to at most one per second and cached in memory. Production deployments should self-host Nominatim and OSRM or select a provider with an appropriate service agreement.

## Vision configuration

`VISION_MODEL` defaults to `yolo11n.pt`, a compact general-purpose COCO model downloaded by Ultralytics on first use. You can choose another local model path. `WARNING_CONFIDENCE`, `NEAR_FRAME_FRACTION`, and `CRITICAL_FRAME_FRACTION` control the alert thresholds.

The proximity score is only a heuristic based on object bounding-box coverage, because a monocular image cannot reliably measure distance. Calibrate and evaluate it in the intended environment before any field use.

## API

- `POST /api/detect` multipart `frame`: returns detections and the highest-risk warning
- `POST /api/navigate` JSON `{ "destination": "...", "origin": { "lat": ..., "lng": ... } }`: selects the nearest place and returns pedestrian maneuvers
- `GET /healthz`: component status without secrets

## Project layout

```text
app/main.py                 FastAPI server and static host
app/vision.py               Local detector and risk policy
web/index.html              Accessible mobile UI
web/app.js                  camera, snapshot, voice, alert, and Maps-link logic
```

## Validate before field testing

1. Test the audio and vibration with the device volume/Focus configuration you intend to use.
2. Test indoors with a sighted assistant and known, stationary objects.
3. Verify that low, transparent, narrow, and overhead hazards are treated as known failure cases.
4. Confirm that place matching and pedestrian routing are correct before relying on them.
5. Keep image processing local unless you have explicitly chosen a remote model and consented to its data handling.

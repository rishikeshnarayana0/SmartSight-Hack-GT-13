# SmartSight — assistive navigation prototype

## Quick start (existing installation)

From the project root, run `python3 scripts/dev.py`. This starts the YOLO server
and Expo development bundler, and sets the phone's server address. If multiple
network interfaces are found, use `python3 scripts/dev.py --ip YOUR_LAPTOP_IP`.
The phone and laptop must be reachable on the same network; USB alone does not
make the WebSocket connection work. Keep the app foregrounded.

After these changes, rebuild the native app once:

```bash
cd mobile
npm install
npx expo run:ios --device
```

Use Xcode's Personal Team signing for the free-account local build. Expo Go
cannot provide this app's native speech recognition. The new SVG and audio
dependencies also require rebuilding; reloading JavaScript is not sufficient.

See [pitch plan](docs/PITCH_PLAN.md) and [1–3 minute video plan](docs/VIDEO_PLAN.md).

## Optional ElevenLabs voice

Set `ELEVENLABS_API_KEY` in the server's environment before starting it. Keep it
out of `EXPO_PUBLIC_*`, source files, and Git. `.env.example` documents supported
variables; the server does not automatically load `.env`. The integration uses
the [ElevenLabs speech endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
If the service is unavailable, the phone falls back to device speech. Generated
audio is cached only in server memory. The LAN session token is not production
authentication: do not expose this server to the public internet. Cloud voice
sends spoken instruction text to ElevenLabs, not camera frames.

The interface includes a fitted camera overlay, object labels/confidences,
estimated boundary lines, a north-up route overview, next-step distance, camera-only
mode, and connection/latency/voice diagnostics. Path lines are heuristic estimates,
not a guarantee of walkable space. They disappear when no boundary pair is found.

A deliberately small proof of concept for an obstacle-warning wearable:

- An Arduino-compatible board and ultrasonic sensor detect nearby objects.
- A vibration motor gives immediate feedback without relying on a network.
- A small Python server runs a fast YOLO collision gate on phone-camera frames,
  then calls a vision-language model only when the gate finds a likely obstacle.
- An Expo phone app provides camera streaming, speech recognition, walking routes,
  haptics, and spoken alerts.

The phone is the camera. The hardware distance sensor remains an independent
detector and still works if Wi-Fi drops. Camera frames are checked by YOLO at
up to ten frames per second, with a strict one-frame-in-flight gate. A new
frame is not captured while the previous frame is being processed or while
spoken audio is playing. A likely collision is warned at most once every two
seconds. The default output is YOLO-only: an object label and avoidance suggestion.
The camera preview draws normalized YOLO boxes and labels plus a
Canny/Hough estimate of converging lower-image boundaries. This is a cheap
heuristic, not semantic walkable-path segmentation. If the optional Ollama
model is enabled, only the warning frame is sent for spoken guidance, and the
phone pauses capture while it runs.

> This is an experimental aid, not a certified mobility or safety device. Do not rely on it as a replacement for a cane, guide dog, trained assistance, or normal safety practices.

## Folder layout

```text
hardware/   Arduino sketch for the distance sensor and vibration motor
server/     Python WebSocket and USB-serial bridge
mobile/     Expo camera, haptic, and speech client
```

## Parts

- Arduino Uno or Nano
- HC-SR04 ultrasonic sensor
- 3 V vibration motor
- NPN transistor such as 2N2222
- 1 kOhm resistor
- Flyback diode such as 1N4148 or 1N400x
- Breadboard, jumper wires, and USB cable

Do not power the motor directly from a microcontroller pin. Use the transistor and diode shown below.

## Wiring

| Part | Connection |
| --- | --- |
| HC-SR04 VCC | Arduino 5V |
| HC-SR04 GND | Arduino GND |
| HC-SR04 TRIG | Arduino D9 |
| HC-SR04 ECHO | Arduino D10 |
| Arduino D5 | 1 kOhm resistor, then transistor base |
| Transistor emitter | GND |
| Transistor collector | Motor negative |
| Motor positive | 3.3 V or suitable motor supply |
| Flyback diode | Across motor, stripe toward motor positive |

If you use a 3.3 V board such as an ESP32, level-shift or divide the HC-SR04 ECHO signal before it reaches the board.

## 1. Flash the hardware

Open `hardware/obstacle_alert/obstacle_alert.ino` in Arduino IDE, choose the board and USB port, then upload it. The default alert distance is 100 cm. Change `ALERT_DISTANCE_CM` near the top of the sketch if needed.

The motor works on its own after upload. The board also emits one JSON line every 250 ms over USB serial.

## 2. Install the local models

Ollama is optional and is not required for the default YOLO-only demo.
To enable it, install [Ollama](https://ollama.com), start it, and pull a vision model:

```bash
ollama pull qwen2.5vl:3b
```

The optional VLM is `qwen2.5vl:3b`, which is substantially lighter than a 7B
model. You can choose another Ollama vision model with `VISION_MODEL` or
`--vision-model`.

The first camera frame also downloads `yolo11n.pt` through Ultralytics. YOLO is
the fast gate; Qwen is the slower instruction writer.

## 3. Start the server

From this folder:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r server/requirements.txt
python server/main.py
```

The default command uses the YOLO gate and speaks a short object plus action instruction:

```bash
python server/main.py --detector yolo --vision-provider off
```

Stair instructions require stair-aware/custom YOLO weights because the stock
`yolo11n.pt` COCO model has no stairs class. Replace the example path below
with a real downloaded weights file; do not paste the placeholder literally:

```bash
python server/main.py \
  --detector yolo \
  --detector-model "$HOME/models/stair-aware.pt" \
  --vision-provider off
```

To enable Qwen after the YOLO collision warning:

```bash
python server/main.py --detector yolo --vision-provider ollama --vision-model qwen2.5vl:3b
```

For a UI smoke test without a model, use the deterministic provider:

```bash
python server/main.py --detector mock --vision-provider mock
```

To bridge the connected board, pass its serial port:

```bash
python server/main.py --serial-port /dev/cu.usbmodemXXXX
```

On macOS, list likely ports with `ls /dev/cu.usb*`. The server listens on port `8765`.

Quick checks:

```bash
curl http://localhost:8765/health
python -m unittest discover -s server/tests
```

## 4. Build and start the phone app

Speech-to-text uses the native iOS/Android speech recognizer, so Expo Go is no
longer sufficient. This project is configured as an Expo development build.

Install EAS CLI and log in:

```bash
npm install --global eas-cli
eas login
```

Create the development build:

```bash
cd mobile
eas build --platform ios --profile development
```

For an Android APK instead:

```bash
eas build --platform android --profile development
```

Install the completed build on the phone, then start the JavaScript bundler:

```bash
cd mobile
npm install
npx expo start --dev-client
```

Navigation adds the native `expo-location` module. After pulling this change,
rebuild the local iOS development app once with `npx expo run:ios --device`
before starting Metro again.

The SDK 57 mobile dependencies require Node.js 22.13.0 or newer. The mobile
folder includes an `.nvmrc` with the minimum supported version.

In the app, enter `ws://YOUR_COMPUTER_LAN_IP:8765/ws` and tap **Connect**.
Then tap **Navigate / speak** and say a destination when prompted. The app
requests foreground location, sends the destination and current coordinates to
the laptop, and receives a walking route. It speaks the first step and watches
GPS to speak each following step as you reach the maneuver. The phone attempts
capture every 100 ms when processing and speech are idle; this is not guaranteed
10 FPS. It sends the small JPEG to YOLO. In the default mode, a
possible collision triggers an immediate haptic warning and a short spoken
avoidance instruction such as `Person detected. Move right, then continue
straight.`. A custom stair label prompts the user to pause and check whether
steps go up or down; stock weights cannot recognize stairs. The direction is chosen from the detected box's
visible left/right clearance; it is a simple heuristic, not a guarantee that
either side is safe.
If Qwen is enabled, the phone waits for it to finish
before capturing another frame. Routing uses OpenStreetMap Nominatim plus the
public OpenStreetMap foot router; those services are rate limited and intended
here only for a key-free demo. The computer and phone must be on the same
network.

To change the capture interval, set `EXPO_PUBLIC_CAPTURE_INTERVAL_MS` before
starting Expo. The default is `100` ms (up to ten attempts per second); values
below 100 ms are clamped. The in-flight and audio gates can make the observed
rate lower when inference or speech takes longer.

Use **Test alert** before connecting hardware. It exercises the complete server-to-phone haptic and speech path.

## Protocol

Phone to server:

```json
{"type":"frame","id":"123","image":"base64-jpeg"}
{"type":"demo_alert"}
{"type":"route_start","destination":"Student Center","latitude":33.7756,"longitude":-84.3963}
```

Hardware to server, over USB serial:

```json
{"type":"distance","cm":42.1,"hazard":true}
```

Server to phone:

```json
{"type":"distance","cm":42.1,"hazard":true}
{"type":"alert","source":"hardware","message":"Obstacle 42 centimeters ahead."}
{"type":"collision_warning","source":"detector","label":"person","message":"Person detected. Move right, then continue straight."}
{"type":"alert","source":"detector","message":"Person detected. Move right, then continue straight."}
{"type":"detector_result","hazard":false,"label":"object","confidence":0,"detections":[],"edge_map":"base64-png","warning_emitted":false}
{"type":"pipeline_state","state":"busy"}
{"type":"vision_result","hazard":true,"message":"Step left."}
{"type":"route_plan","route":{"destination":"Student Center","distance_m":312,"duration_s":240,"steps":[{"instruction":"Start walking.","distance_m":70,"distance_to_maneuver_m":0,"latitude":33.7756,"longitude":-84.3963}]}}
```

The clean extension points are `server/detector.py` for replacing YOLO and
`server/vision.py` for replacing the VLM. Keep their small result interfaces;
the hardware and phone code do not need to change.

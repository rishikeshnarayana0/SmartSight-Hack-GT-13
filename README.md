# Assistive Hardware Prototype

A deliberately small proof of concept for an obstacle-warning wearable:

- An Arduino-compatible board and ultrasonic sensor detect nearby objects.
- A vibration motor gives immediate feedback without relying on a network.
- A small Python server runs a fast YOLO collision gate on phone-camera frames,
  then calls a vision-language model only when the gate finds a likely obstacle.
- An Expo phone app provides camera streaming, speech recognition, haptics, and spoken alerts.

The phone is the camera. The hardware distance sensor remains an independent
detector and still works if Wi-Fi drops. Camera frames are checked by YOLO at
the phone's one-second capture rate. A likely collision is warned at most once
every two seconds. The default output is YOLO-only: `Person ahead.` or `Chair
ahead.`. If the optional Ollama model is enabled, only the warning frame is
sent for spoken guidance, and the phone pauses capture while it runs.

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

Install [Ollama](https://ollama.com), start it, and pull a vision model:

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

The default command uses the YOLO gate and speaks only its short object label:

```bash
python server/main.py --detector yolo --vision-provider off
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

The SDK 57 mobile dependencies require Node.js 22.13.0 or newer. The mobile
folder includes an `.nvmrc` with the minimum supported version.

In the app, enter `ws://YOUR_COMPUTER_LAN_IP:8765/ws` and tap **Connect**.
Then tap **Start camera / speak** and say a destination when prompted. The app
stops listening after the recognizer returns the destination, then starts the
camera loop. Every second the phone captures a small JPEG and sends it to YOLO.
In the default mode, a possible collision triggers an immediate haptic warning
and a short spoken label such as `Person ahead.`. If Qwen is enabled, the phone
waits for it to finish before capturing another frame. The destination capture
is the first navigation MVP step; route calculation and turn-by-turn
instructions are not yet connected. The computer and phone must be on the same
network.

To change the capture interval, set `EXPO_PUBLIC_CAPTURE_INTERVAL_MS` before
starting Expo. For example, `500` captures twice per second; values below 500
ms are clamped.

Use **Test alert** before connecting hardware. It exercises the complete server-to-phone haptic and speech path.

## Protocol

Phone to server:

```json
{"type":"frame","id":"123","image":"base64-jpeg"}
{"type":"demo_alert"}
```

Hardware to server, over USB serial:

```json
{"type":"distance","cm":42.1,"hazard":true}
```

Server to phone:

```json
{"type":"distance","cm":42.1,"hazard":true}
{"type":"alert","source":"hardware","message":"Obstacle 42 centimeters ahead."}
{"type":"collision_warning","source":"detector","label":"person","message":"Person ahead."}
{"type":"alert","source":"detector","message":"Person ahead."}
{"type":"pipeline_state","state":"busy"}
{"type":"vision_result","hazard":true,"message":"Step left."}
```

The clean extension points are `server/detector.py` for replacing YOLO and
`server/vision.py` for replacing the VLM. Keep their small result interfaces;
the hardware and phone code do not need to change.

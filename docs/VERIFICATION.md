# Implementation verification — 2026-09-26

## Completed locally

- 21 Python unit/integration tests pass, including speech endpoint authentication,
  missing-key fallback, busy rejection, blank-image abstention, converging path
  boundaries, and client-specific alerts.
- `npm run typecheck` passes.
- Expo iOS JavaScript export succeeds.
- Native prebuild and CocoaPods installation succeed.
- Xcode generic iOS Debug build with `CODE_SIGNING_ALLOWED=NO` reports
  `BUILD SUCCEEDED`. This is compilation, not installation or signing validation.
- Existing `yolo11n.pt` processed a synthetic image with converging lines:
  no object hazard, estimated boundaries returned, correct 320×240 frame size.
  The single cold run took 2.14 seconds including model loading. This is a smoke
  test, NOT a real-world accuracy or steady-state latency benchmark.
- `git diff --check` passes.

## Still requires the phone / live services

- Rebuild and install the signed development app on the iPhone; it was unavailable
  to Xcode during verification. No simulator runtime was installed.
- Check the visual layout and camera-overlay alignment on the actual device.
- Test microphone permissions, speech recognition, route progression, camera audio
  gating, and recovery under real motion.
- Supply an ElevenLabs key locally and test both cloud playback and device fallback.
  Endpoint behavior is tested with fixtures; live synthesis has not been verified.
- Measure warning-onset latency, false alerts, missed obstacles, and path-estimate
  failures. Do not present the 100 ms capture timer as measured 10 FPS.

## Deliberately out of scope for this build

Metric depth, ground segmentation, SLAM, autonomous obstacle traversal, automatic
off-route replanning, stair recognition, and safety certification. Canny
boundary estimates and bounding-box avoidance cannot establish safe movement.
Camera processing pauses during speech as requested, creating a perception gap.
Use a controlled, supervised demo and disclose this limitation.

Implementation was verified locally before the user requested committing and pushing it.

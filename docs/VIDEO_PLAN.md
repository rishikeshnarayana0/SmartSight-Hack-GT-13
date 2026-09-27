# SmartSight video plan

## Recommended cut: 2 minutes

Record landscape at 1080p. Use a screen recording of the actual iPhone app plus a camera angle showing the operator and obstacle. Retain original detection audio and subtitles. Use the supplied IntelliCane video's picture-in-picture concept as inspiration, but record fresh footage of this prototype.

| Time | Picture / action | Narration / audio |
|---|---|---|
| 0:00–0:12 | Person pauses before a chair in a controlled corridor. Title: SmartSight. | “Knowing the next turn is only part of a walk. A temporary obstacle can change what is directly ahead.” |
| 0:12–0:26 | Show phone and laptop together. Open connection settings briefly, then hide them. | “SmartSight connects an iPhone camera to a nearby laptop and combines object awareness with spoken walking directions.” |
| 0:26–0:43 | User says a real destination outdoors. App displays the route overview and first instruction. | Use actual microphone capture and response audio. Caption the destination and first turn. If GPS is staged, label it “simulated GPS” throughout that segment. |
| 0:43–1:04 | Cut to a controlled obstacle setup. Show the chair and its labeled box simultaneously. | Let the real alert play. “The camera identifies the object. The app speaks a short warning and gives haptic feedback.” Do not dub a response that the app did not produce. |
| 1:04–1:17 | Second object blocks the suggested side. App gives a pause warning. | “When detected objects obstruct both sides, the prototype asks the user to pause.” Record this only after the behavior passes the controlled test. |
| 1:17–1:30 | Remove obstacle. Show several subsequent frames and the recovery message. | Use actual “Obstacle no longer detected” audio. Don't describe this as proof of safe ground. |
| 1:30–1:44 | Camera estimate and route overview, then simple architecture slide. | “Image boundaries and GPS directions are separate. YOLO runs on the laptop. The phone queues feedback, with optional ElevenLabs speech and a device-voice fallback.” |
| 1:44–1:54 | Show a real measurement table or a labeled evaluation-plan slide. | State measured results only. Without completed tests: “Next we are measuring missed obstacles, false alerts, and warning delay across repeatable trials.” |
| 1:54–2:00 | Team and working prototype. Repository link. | “Our next step is evaluation with mobility specialists and users. SmartSight is a prototype for supervised testing.” |

## Alternate lengths

**60 seconds:** 0–8 problem, 8–18 spoken destination and route, 18–38 actual chair warning and recovery, 38–50 architecture, 50–60 limitations and next test. Keep one clear successful interaction, not a rapid feature montage.

**180 seconds:** Use the two-minute cut, plus 20 seconds explaining source attribution and contributions, 20 seconds demonstrating loss of connectivity, and 20 seconds on actual measured results and test conditions. Do not pad with unsupported future features.

## Shot list

1. Wide establishing shot of the marked test area and sighted operator.
2. Close-up of the phone, readable at normal playback size.
3. A synchronized external view and screen recording of chair detection.
4. A blocked-side case and a recovery case.
5. Outdoor destination capture and GPS guidance, separately from indoor detection testing.
6. Screen capture of fallback if ElevenLabs is unavailable. Label provider accurately.
7. Team shot with only the hardware actually used in the demo.

## Recording checklist

- Rebuild the native app after adding expo-audio and react-native-svg.
- Confirm camera, location, speech and local-network permissions before recording.
- Run the server with the existing yolo11n.pt weights and VLM off.
- Keep USB connected if using its link-local address. Confirm the app shows Connected.
- Use “Camera only” for obstacle footage without a route dependency.
- Put the phone's rear camera forward at a consistent height and angle. Camera left/right must match the operator's left/right.
- Keep background music below speech. Caption spoken alerts. Record room tone.
- Record failures too. Keep the original continuous takes so edits do not imply lower latency.
- Label accelerated footage, pre-recorded scenes and simulations. Don't splice different trials into an apparent continuous successful run.
- Do not show API keys, account pages, bystanders or private destination data.

## What to leave out

No promise of collision-free movement, stairs climbing, crosswalk safety, autonomous path following, metric distance from a monocular bounding box, or proven accessibility benefits. These need capabilities and evidence beyond this build. The ISEF video's depth inset belongs to that project and should not appear as our live output.

# SmartSight pitch plan

## The pitch

“SmartSight combines spoken walking directions with awareness of objects in front of the user. Say a destination, follow the route, and hear a concise warning when the camera detects a possible obstacle.”

Audience: hackathon judges. Default presentation length: 3 minutes, with a separate 2-minute demo video. This is a prototype for supervised evaluation, not a validated mobility aid. Avoid claiming that it replaces a cane or guide dog.

## What the ISEF materials teach us

Reference: *2025 ISEF Slides Final.pdf*, IntelliCane, Tanay Chitlur and Akash Ragam, exhibit ROBO066T. The supplied demo video is 31.96 seconds long. Visual sampling shows an indoor cane demonstration with a depth inset, followed by outdoor red/green path-boundary overlays and an aerial inset. Audio was not transcribed in this review.

- Page 4 makes the hardware and intended behaviors concrete. Our equivalent should show the iPhone, laptop, and any genuinely connected hardware, with current roles clearly labeled.
- Pages 5–8 separate perception from reasoning and feedback. Use one simpler architecture slide for our phone-camera, YOLO, route, and speech pipeline.
- Pages 9–10 pair behaviors with test methodology. Adopt the measurement discipline, not their numbers. Their reported contacts are cane contacts with things other than the floor, not necessarily bodily collisions. The outdoor method states 10 two-minute trials per path type and no blindfolds. Do not relabel those as our results or clinical validation.
- Page 11 lists GPS waypoint navigation as future work. Our spoken destination and GPS route can be a useful concrete distinction, without claiming superiority over their whole system.
- The video makes a visible action and perception output appear together. Film our actual phone screen beside the person and obstacle so judges can connect detection to feedback.

Do not reuse the supplied deck's population estimates, guide-dog costs, comparative product claims, recognition rates, $207 hardware cost, or performance measurements as SmartSight facts. Do not claim our project has their custom depth model, A*, SLAM, Raspberry Pi optimization, or servo guidance. If team members contributed to IntelliCane, explain the relationship accurately in the submission. Otherwise describe it as inspiration and attribute it.

## Seven-slide deck

| Slide | On-slide copy | Visual | Speaker notes / evidence |
|---|---|---|---|
| 1. SmartSight | Spoken directions with nearby obstacle awareness | Real phone camera screenshot with a chair box | “We connect the destination someone names with what their camera sees along the way.” Avoid broad claims about independence that have not been evaluated. |
| 2. The navigation gap | A route describes turns. Temporary obstacles change the walk. | Photo of the controlled demo setup | Explain the particular scenario: chair placed in a walking corridor after the route was planned. Existing mobility tools remain useful. |
| 3. One continuous interaction | Say a destination. Hear directions. Receive obstacle feedback. | Three sequential frames from our recorded run | Play the voice input, route, and warning in their actual order. Display any simulated GPS prominently. |
| 4. How it works | Camera on iPhone. Detection on laptop. Walking route from OSM services. Spoken feedback on phone. | One architecture diagram with optional ElevenLabs branch | YOLO is stock, bounding-box proximity is heuristic, boundary estimation uses Canny/Hough, route geometry comes from the routing service. Optional VLM remains off for the core demo. |
| 5. What the screen tells us | Objects, estimated boundaries, and a GPS route | Annotated real screenshot | Distinguish camera-space boundary lines from the north-up route diagram. Neither is a depth map or a guaranteed safe corridor. Explain that frames pause during speech in this version. |
| 6. What we measured | Report actual trial results here after testing | Small table: trial count, warning-onset latency median/p95, missed obstacles, false warnings | Until measurements exist, title this “Evaluation plan.” Don't present the processing timer as FPS or frame round-trip time as speech-onset time. State device, lighting, network, model and sample count. |
| 7. Next validation | Evaluate with mobility specialists and users. Improve ground and step understanding. | Team / prototype photo | State current limits: no verified stair direction, no metric depth, no autonomous traversal, network dependence. Give judges one concrete next experiment. |

Use a dark navy background with warm white type, teal for route/boundary estimates and amber for detections. Keep one main visual per slide. Use actual app screenshots after the native build is tested. Do not fabricate screenshots that imply working capabilities.

## Evidence checklist

- Record 10 controlled stationary-obstacle trials, including chair left, chair right, centered obstruction, two obstacles, and an empty corridor.
- Log missed detections and unwanted alerts, not just successful runs.
- Measure capture-to-result separately from capture-to-audible-warning. Measure first ElevenLabs request separately from cached requests.
- Test disconnection, denied microphone permission, unavailable route service, and ElevenLabs fallback.
- No blindfolded walking or stairs trial is necessary for the hackathon demo. Use a sighted operator with a spotter.
- Record walking-route behavior outdoors in a permitted area. Indoors, label any staged route visualization as simulation.

## Likely judge questions

**What did you build?** The phone/server integration, route presentation, perception overlays, obstacle policy, speech queue/fallback, and demo workflow. Credit pretrained models and external services.

**Is it all running on the phone?** No. The phone captures frames, obtains GPS and plays feedback. A nearby laptop runs YOLO and calls routing/TTS services.

**Can it recognize stairs?** The installed COCO model cannot. The code accepts stair labels from suitable weights, but warns to check step direction rather than prescribing a climb.

**Does the colored corridor prove it is safe?** No. It estimates two converging image boundaries. Ground segmentation, depth, and empirical validation are future work.

**What is new since the prior project?** List the actual hackathon contribution and timestamps. Disclose inherited code and research. Do not claim an earlier ISEF evaluation validates this implementation.

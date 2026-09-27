"""Image-space path boundary estimate. No metric depth or free-space claim."""
import cv2
import numpy as np


def estimate_path(image):
    gray = cv2.cvtColor(np.asarray(image.resize((320, 240))), cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 60, 140)
    edges[:105] = 0
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 25, minLineLength=45, maxLineGap=18)
    left, right = [], []
    for x1, y1, x2, y2 in ([] if lines is None else np.asarray(lines).reshape(-1, 4)):
        if abs(y2 - y1) < 35:
            continue
        slope = (x2 - x1) / (y2 - y1)
        bottom = x1 + (235 - y1) * slope
        top = x1 + (120 - y1) * slope
        if 0 <= bottom < 145 and bottom < top < 180:
            left.append((bottom, top))
        if 175 < bottom <= 320 and 140 < top < bottom:
            right.append((bottom, top))
    if not left or not right:
        return None
    lb, lt = np.median(left, axis=0)
    rb, rt = np.median(right, axis=0)
    if rt - lt < 20 or rb - lb < 80:
        return None
    return {"polygon": [[lb/320, .98], [lt/320, .5], [rt/320, .5], [rb/320, .98]],
            "center": [[(lb+rb)/640, .98], [(lt+rt)/640, .5]],
            "kind": "estimated_boundaries"}

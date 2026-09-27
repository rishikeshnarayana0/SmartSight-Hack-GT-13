import Svg, { Circle, Line, Polygon, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { View, Text } from "react-native";

type Box = { x: number; y: number; width: number; height: number; label: string; confidence: number };
export function PerceptionOverlay({ boxes, path, frame, size }: {
  boxes: Box[]; path?: { polygon: number[][]; center: number[][] } | null;
  frame: number[]; size: { width: number; height: number };
}) {
  const scale = Math.max(size.width / frame[0], size.height / frame[1]);
  const width = frame[0] * scale, height = frame[1] * scale;
  const dx = (size.width - width) / 2, dy = (size.height - height) / 2;
  const point = ([x, y]: number[]) => `${dx + x * width},${dy + y * height}`;
  return <Svg pointerEvents="none" width="100%" height="100%" style={{ position: "absolute" }}>
    {path && <>
      <Polygon points={path.polygon.map(point).join(" ")} fill="rgba(91,214,226,.13)" stroke="#5bd6e2" strokeWidth={2} />
      <Polyline points={path.center.map(point).join(" ")} stroke="#5bd6e2" strokeWidth={3} strokeDasharray="9 8" />
    </>}
    {boxes.map((box, i) => {
      const x = dx + box.x * width, y = dy + box.y * height;
      return <ViewlessBox key={i} x={x} y={y} width={box.width * width} height={box.height * height}
        label={`${box.label} ${Math.round(box.confidence * 100)}%`} />;
    })}
  </Svg>;
}
function ViewlessBox({ x, y, width, height, label }: { x: number; y: number; width: number; height: number; label: string }) {
  return <>
    <Rect x={x} y={y} width={width} height={height} fill="none" stroke="#f6cd70" strokeWidth={2} rx={4} />
    <Rect x={Math.max(0, x)} y={Math.max(0, y)} width={Math.min(190, label.length * 8 + 16)} height={24} fill="#172329" rx={4} />
    <SvgText x={Math.max(0, x) + 8} y={Math.max(0, y) + 17} fill="#f6cd70" fontSize={13}>{label}</SvgText>
  </>;
}

export function RouteOverview({ coordinates, position }: { coordinates: number[][]; position: number[] | null }) {
  if (coordinates.length < 2) return <Text style={{ color: "#91a7ad", padding: 16 }}>Say a destination to see your walking route.</Text>;
  const all = position ? [...coordinates, position] : coordinates;
  const lat = all[0][1] * Math.PI / 180;
  const projected = all.map(([lon, y]) => [lon * Math.cos(lat), y]);
  const minX = Math.min(...projected.map(p => p[0])), maxX = Math.max(...projected.map(p => p[0]));
  const minY = Math.min(...projected.map(p => p[1])), maxY = Math.max(...projected.map(p => p[1]));
  const scale = Math.min(288 / Math.max(maxX - minX, .00001), 92 / Math.max(maxY - minY, .00001));
  const points = projected.map(([x, y]) => [160 + (x - (minX + maxX) / 2) * scale, 62 - (y - (minY + maxY) / 2) * scale]);
  const route = points.slice(0, coordinates.length), end = route[route.length - 1];
  const user = position ? points[points.length - 1] : null;
  return <View accessibilityLabel="Walking route overview. North is up.">
    <Svg width="100%" height={124} viewBox="0 0 320 124">
      {[40, 80, 120, 160, 200, 240, 280].map(x => <Line key={x} x1={x} x2={x} y1={0} y2={124} stroke="#23383f" />)}
      <Polyline points={route.map(p => p.join(",")).join(" ")} stroke="#61d8c5" strokeWidth={4} fill="none" />
      <Circle cx={route[0][0]} cy={route[0][1]} r={4} fill="#91a7ad" />
      <Circle cx={end[0]} cy={end[1]} r={6} fill="#f6cd70" />
      {user && <Circle cx={user[0]} cy={user[1]} r={6} fill="white" stroke="#61d8c5" strokeWidth={3} />}
      <SvgText x={300} y={16} fill="#91a7ad" fontSize={12}>N</SvgText>
    </Svg>
  </View>;
}

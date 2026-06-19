import React from "react";
import { AbsoluteFill, Composition, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import demoData from "./demoData.json" with { type: "json" };

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const DURATION = demoData.durationSeconds * FPS;

export function Root() {
  return (
    <Composition
      id="AgentdiffDemo"
      component={AgentdiffDemo}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
}

function AgentdiffDemo() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const sceneDuration = Math.floor(durationInFrames / demoData.scenes.length);
  const sceneIndex = Math.min(demoData.scenes.length - 1, Math.floor(frame / sceneDuration));
  const sceneFrame = frame - sceneIndex * sceneDuration;
  const scene = demoData.scenes[sceneIndex];
  const progress = frame / durationInFrames;

  return (
    <AbsoluteFill style={styles.stage}>
      <div style={styles.backgroundGrid} />
      <div style={styles.topBar}>
        <div style={styles.brand}>agentdiff</div>
        <div style={styles.status}>open-source ci for ai agent behavior</div>
      </div>
      <main style={styles.main}>
        <SceneText scene={scene} sceneFrame={sceneFrame} />
        <ReportPanel scene={scene} sceneIndex={sceneIndex} />
      </main>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${progress * 100}%` }} />
      </div>
    </AbsoluteFill>
  );
}

function SceneText({ scene, sceneFrame }) {
  const { fps } = useVideoConfig();
  const entrance = spring({ frame: sceneFrame, fps, config: { damping: 18 } });
  const opacity = interpolate(sceneFrame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  return (
    <section style={{ ...styles.sceneText, opacity, transform: `translateY(${(1 - entrance) * 48}px)` }}>
      <div style={styles.kicker}>{scene.kicker}</div>
      <h1 style={styles.headline}>{scene.headline}</h1>
      <p style={styles.body}>{scene.body}</p>
      <div style={styles.tagline}>{demoData.tagline}</div>
    </section>
  );
}

function ReportPanel({ scene, sceneIndex }) {
  const frame = useCurrentFrame();
  const panelFrame = frame % Math.floor(DURATION / demoData.scenes.length);
  const opacity = interpolate(panelFrame, [6, 24], [0, 1], { extrapolateRight: "clamp" });

  return (
    <section style={{ ...styles.report, opacity }}>
      <div style={styles.reportHeader}>
        <span>agentdiff report</span>
        <span style={sceneIndex === 0 ? styles.pass : styles.action}>action_required</span>
      </div>
      <div style={styles.reportTitle}>{scene.headline}</div>
      <ul style={styles.bullets}>
        {scene.bullets.map((bullet) => (
          <li key={bullet} style={styles.bullet}>
            <span style={styles.bulletMarker}>+</span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      {scene.kicker === "Install" ? <pre style={styles.code}>{demoData.installSnippet}</pre> : null}
    </section>
  );
}

const styles = {
  stage: {
    background: "#f6f7f9",
    color: "#16181d",
    fontFamily: "Inter, Arial, sans-serif",
    overflow: "hidden"
  },
  backgroundGrid: {
    position: "absolute",
    inset: 0,
    backgroundImage: "linear-gradient(rgba(22,24,29,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(22,24,29,0.08) 1px, transparent 1px)",
    backgroundSize: "64px 64px",
    opacity: 0.45
  },
  topBar: {
    position: "absolute",
    top: 54,
    left: 72,
    right: 72,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 30,
    fontWeight: 700
  },
  brand: {
    letterSpacing: 0
  },
  status: {
    fontSize: 24,
    color: "#58606f",
    fontWeight: 500
  },
  main: {
    position: "absolute",
    inset: "164px 72px 112px",
    display: "grid",
    gridTemplateColumns: "1fr 760px",
    gap: 72,
    alignItems: "center"
  },
  sceneText: {
    maxWidth: 900
  },
  kicker: {
    color: "#0f766e",
    fontSize: 34,
    fontWeight: 800,
    marginBottom: 28
  },
  headline: {
    fontSize: 118,
    lineHeight: 1.02,
    margin: 0,
    letterSpacing: 0
  },
  body: {
    fontSize: 42,
    lineHeight: 1.2,
    color: "#414957",
    marginTop: 34,
    marginBottom: 0
  },
  tagline: {
    marginTop: 58,
    paddingTop: 34,
    borderTop: "3px solid #d7dce4",
    color: "#29303b",
    fontSize: 30,
    lineHeight: 1.25
  },
  report: {
    background: "#ffffff",
    border: "2px solid #d8dde6",
    borderRadius: 8,
    boxShadow: "0 30px 70px rgba(22, 24, 29, 0.16)",
    padding: 38,
    minHeight: 600
  },
  reportHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    textTransform: "uppercase",
    color: "#687283",
    fontSize: 22,
    fontWeight: 800,
    marginBottom: 34
  },
  action: {
    color: "#b42318"
  },
  pass: {
    color: "#15803d"
  },
  reportTitle: {
    fontSize: 48,
    lineHeight: 1.08,
    fontWeight: 850,
    marginBottom: 34
  },
  bullets: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "grid",
    gap: 22
  },
  bullet: {
    display: "grid",
    gridTemplateColumns: "34px 1fr",
    alignItems: "start",
    gap: 18,
    fontSize: 30,
    lineHeight: 1.25,
    color: "#2b3340"
  },
  bulletMarker: {
    color: "#b42318",
    fontWeight: 900
  },
  code: {
    marginTop: 34,
    padding: 24,
    borderRadius: 8,
    background: "#111827",
    color: "#d1fae5",
    fontSize: 24,
    lineHeight: 1.32,
    whiteSpace: "pre-wrap"
  },
  progressTrack: {
    position: "absolute",
    left: 72,
    right: 72,
    bottom: 54,
    height: 10,
    background: "#d7dce4",
    borderRadius: 999
  },
  progressFill: {
    height: "100%",
    background: "#0f766e",
    borderRadius: 999
  }
};

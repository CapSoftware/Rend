"use client";

import { useEffect } from "react";
import { attachPlayback, type AttachPlaybackOptions } from "../../../lib/player-engine.ts";
import { mountControls } from "../../../lib/player-controls.ts";

type EmbedPlayerClientProps = AttachPlaybackOptions & {
  playerId: string;
  controls: boolean;
  startTime?: number;
};

export function EmbedPlayerClient(props: EmbedPlayerClientProps) {
  useEffect(() => {
    const player = document.getElementById(props.playerId);
    const video = player?.querySelector("video");
    if (!(player instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) return;

    let cleanupControls = () => undefined as void;
    if (props.controls) {
      try {
        cleanupControls = mountControls(player, video, { startTime: props.startTime });
      } catch {
        video.setAttribute("controls", "");
        player.classList.remove("rend-player--ui");
      }
    }

    const cleanupPlayback = attachPlayback(player, video, {
      assetId: props.assetId,
      autoPlay: props.autoPlay,
      bootstrapUrl: props.bootstrapUrl,
      initialBootstrap: props.initialBootstrap,
      initialBootstrapMs: props.initialBootstrapMs,
      playbackEngine: props.playbackEngine,
      startupMode: props.startupMode,
      telemetryAppVersion: props.telemetryAppVersion,
      telemetryEnabled: props.telemetryEnabled,
      telemetryOrganizationId: props.telemetryOrganizationId,
      telemetryPageType: props.telemetryPageType,
      telemetryUrl: props.telemetryUrl,
      richTelemetry: true,
    });

    return () => {
      cleanupPlayback();
      cleanupControls();
    };
  }, [props]);

  return null;
}

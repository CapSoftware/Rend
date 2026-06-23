"use client";

import { useEffect } from "react";
import { attachPlayback, type AttachPlaybackOptions } from "../../../lib/player-engine.ts";

type WatchPlayerEnhancerProps = AttachPlaybackOptions & {
  playerId: string;
};

export function WatchPlayerEnhancer(props: WatchPlayerEnhancerProps) {
  useEffect(() => {
    const player = document.getElementById(props.playerId);
    const video = player?.querySelector("video");
    if (!(player instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) return;
    return attachPlayback(player, video, props);
  }, [props]);

  return null;
}

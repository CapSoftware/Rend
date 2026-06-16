import type { RendPlayerPlaybackMode } from "./telemetry";

export type PlaybackSourceData = {
  manifest_url?: string;
  opener_url?: string;
  playback_url?: string;
  playable_state?: string;
};

export type HlsSupport = {
  hlsJs: boolean;
  nativeHls: boolean;
};

export type SourceSelection = {
  label: RendPlayerPlaybackMode;
  artifactPath: string;
  url: string;
};

export function hlsSource(
  data: PlaybackSourceData,
  support: HlsSupport
): SourceSelection | null {
  if (data.manifest_url && support.nativeHls) {
    return {
      label: "native_hls",
      artifactPath: "hls/master.m3u8",
      url: data.manifest_url,
    };
  }

  if (data.manifest_url && support.hlsJs) {
    return {
      label: "hls_js",
      artifactPath: "hls/master.m3u8",
      url: data.manifest_url,
    };
  }

  return null;
}

export function openerSource(data: PlaybackSourceData): SourceSelection | null {
  if (!data.opener_url) return null;
  return {
    label: "opener",
    artifactPath: "opener.mp4",
    url: data.opener_url,
  };
}

export function fallbackPrimarySource(data: PlaybackSourceData): SourceSelection | null {
  if (!data.playback_url) return null;
  return {
    label: "primary",
    artifactPath: data.playable_state === "hls_ready" ? "hls/master.m3u8" : "opener.mp4",
    url: data.playback_url,
  };
}

export function selectedSource(
  data: PlaybackSourceData,
  support: HlsSupport
): SourceSelection | null {
  const hls = hlsSource(data, support);
  if (data.playable_state === "hls_ready" && hls) return hls;

  return openerSource(data) ?? hls ?? fallbackPrimarySource(data);
}

export type AssetLifecycleState = {
  playable_state: string;
  suspended_at?: string;
  organization_suspended_at?: string;
};

export function isAssetPlayable(playableState: string) {
  return playableState === "opener_ready" || playableState === "hls_ready";
}

export function isAssetProcessingComplete(playableState: string) {
  return playableState === "hls_ready" || playableState === "failed" || playableState === "deleted";
}

export function shouldRefreshAssetLifecycle(asset: AssetLifecycleState) {
  return (
    !asset.suspended_at &&
    !asset.organization_suspended_at &&
    !isAssetProcessingComplete(asset.playable_state)
  );
}

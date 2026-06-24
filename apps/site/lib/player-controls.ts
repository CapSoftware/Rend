export type MountControlsOptions = {
  startTime?: number;
};

type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  requestPictureInPicture?: () => Promise<unknown>;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
  pictureInPictureElement?: Element | null;
  pictureInPictureEnabled?: boolean;
  exitPictureInPicture?: () => Promise<void>;
};

const SEEK_STEP_SECONDS = 5;
const SEEK_JUMP_SECONDS = 10;
const VOLUME_STEP = 0.05;
const INACTIVITY_MS = 2600;
const HAVE_FUTURE_DATA = 3;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function mountControls(
  player: HTMLElement,
  video: HTMLVideoElement,
  options: MountControlsOptions = {}
): () => void {
  const select = <T extends HTMLElement>(selector: string) =>
    player.querySelector(selector) as T | null;

  const controls = select("[data-rend-controls]");
  const bigPlay = select<HTMLButtonElement>("[data-rend-bigplay]");
  const playBtn = select<HTMLButtonElement>("[data-rend-play]");
  const muteBtn = select<HTMLButtonElement>("[data-rend-mute]");
  const fsBtn = select<HTMLButtonElement>("[data-rend-fullscreen]");
  const pipBtn = select<HTMLButtonElement>("[data-rend-pip]");
  const timeline = select("[data-rend-timeline]");
  const rail = select("[data-rend-rail]");
  const buffered = select("[data-rend-buffered]");
  const hoverfill = select("[data-rend-hoverfill]");
  const progress = select("[data-rend-progress]");
  const currentEl = select("[data-rend-current]");
  const durationEl = select("[data-rend-duration]");
  const volSlider = select("[data-rend-volume]");
  const volRail = select("[data-rend-volrail]");
  const volFill = select("[data-rend-volfill]");

  if (!controls) return () => undefined;

  const fsVideo = video as FullscreenVideo;
  const fsPlayer = player as FullscreenElement;
  const fsDoc = document as FullscreenDocument;

  player.classList.add("rend-player--ui");
  video.removeAttribute("controls");
  if (player.getAttribute("tabindex") === null) player.tabIndex = 0;
  controls.setAttribute("aria-hidden", "false");

  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K | string,
    handler: EventListenerOrEventListenerObject,
    opts?: AddEventListenerOptions | boolean
  ) => {
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  };

  let rafId = 0;
  let lastPointerType = "mouse";
  let inactivityTimer = 0;

  const supportsFullscreen = Boolean(
    fsPlayer.requestFullscreen || fsPlayer.webkitRequestFullscreen || fsVideo.webkitEnterFullscreen
  );
  if (!supportsFullscreen && fsBtn) fsBtn.hidden = true;

  const supportsPip = Boolean(
    fsDoc.pictureInPictureEnabled && typeof fsVideo.requestPictureInPicture === "function"
  );
  if (pipBtn) pipBtn.hidden = !supportsPip;

  const isFullscreen = () =>
    Boolean(fsDoc.fullscreenElement || fsDoc.webkitFullscreenElement);

  const reflectPlay = () => {
    const paused = video.paused;
    player.classList.toggle("is-paused", paused);
    player.classList.toggle("is-playing", !paused);
    const label = paused ? "Play" : "Pause";
    playBtn?.setAttribute("aria-label", label);
    bigPlay?.setAttribute("aria-label", "Play");
  };

  const reflectVolume = () => {
    const level = video.muted ? 0 : video.volume;
    player.classList.toggle("is-muted", level === 0);
    player.dataset.rendVolLevel = level === 0 ? "off" : level < 0.5 ? "low" : "high";
    muteBtn?.setAttribute("aria-label", level === 0 ? "Unmute" : "Mute");
    if (volFill) volFill.style.width = `${Math.round(level * 100)}%`;
    if (volSlider) {
      volSlider.setAttribute("aria-valuenow", String(Math.round(level * 100)));
      volSlider.setAttribute("aria-valuetext", `${Math.round(level * 100)}% volume`);
    }
  };

  const updateBuffered = () => {
    if (!buffered) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || video.buffered.length === 0) {
      buffered.style.width = "0%";
      return;
    }
    const end = video.buffered.end(video.buffered.length - 1);
    buffered.style.width = `${clamp((end / duration) * 100, 0, 100)}%`;
  };

  const updateProgress = () => {
    const duration = video.duration;
    const current = video.currentTime;
    if (Number.isFinite(duration) && duration > 0) {
      const pct = clamp((current / duration) * 100, 0, 100);
      if (progress) progress.style.width = `${pct}%`;
      if (timeline) {
        timeline.setAttribute("aria-valuenow", String(Math.round(pct)));
        timeline.setAttribute("aria-valuetext", `${formatTime(current)} of ${formatTime(duration)}`);
      }
    } else if (progress) {
      progress.style.width = "0%";
    }
    if (currentEl) currentEl.textContent = formatTime(current);
    updateBuffered();
  };

  const updateDuration = () => {
    const duration = video.duration;
    const live = !Number.isFinite(duration);
    player.classList.toggle("is-live", live);
    if (durationEl) durationEl.textContent = live ? "Live" : formatTime(duration);
  };

  const tick = () => {
    updateProgress();
    rafId = window.requestAnimationFrame(tick);
  };
  const startTick = () => {
    if (!rafId) rafId = window.requestAnimationFrame(tick);
  };
  const stopTick = () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    updateProgress();
  };

  const clearInactivity = () => {
    if (inactivityTimer) {
      window.clearTimeout(inactivityTimer);
      inactivityTimer = 0;
    }
  };
  const scheduleHide = () => {
    clearInactivity();
    if (video.paused) return;
    inactivityTimer = window.setTimeout(() => {
      player.classList.remove("is-active");
    }, INACTIVITY_MS);
  };
  const showControls = () => {
    player.classList.add("is-active");
    scheduleHide();
  };
  const hasPlayableBuffer = () => video.readyState >= HAVE_FUTURE_DATA;
  const shouldShowBuffering = () => !video.paused && !video.ended && !hasPlayableBuffer();
  const setBuffering = (active: boolean) => {
    player.classList.toggle("is-buffering", active);
  };

  const togglePlay = () => {
    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
    showControls();
  };

  const seekTo = (seconds: number) => {
    const duration = video.duration;
    const max = Number.isFinite(duration) ? duration : seconds;
    video.currentTime = clamp(seconds, 0, max);
    updateProgress();
  };

  const fractionFromPointer = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const capturePointer = (element: HTMLElement, pointerId: number) => {
    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      // Some browsers reject capture when the pointer is no longer active.
    }
  };
  const releasePointer = (element: HTMLElement, pointerId: number) => {
    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      // Releasing an already-released pointer is a no-op we can ignore.
    }
  };

  const enterFullscreen = () => {
    if (fsPlayer.requestFullscreen) void fsPlayer.requestFullscreen().catch(() => undefined);
    else if (fsPlayer.webkitRequestFullscreen) fsPlayer.webkitRequestFullscreen();
    else if (fsVideo.webkitEnterFullscreen) fsVideo.webkitEnterFullscreen();
  };
  const exitFullscreen = () => {
    if (fsDoc.exitFullscreen) void fsDoc.exitFullscreen().catch(() => undefined);
    else if (fsDoc.webkitExitFullscreen) fsDoc.webkitExitFullscreen();
  };
  const toggleFullscreen = () => {
    if (isFullscreen()) exitFullscreen();
    else enterFullscreen();
  };

  const togglePip = async () => {
    if (!supportsPip) return;
    try {
      if (fsDoc.pictureInPictureElement) await fsDoc.exitPictureInPicture?.();
      else await fsVideo.requestPictureInPicture?.();
    } catch {
      // Picture-in-picture can be rejected by the browser; ignore.
    }
  };

  reflectPlay();
  reflectVolume();
  updateDuration();
  updateProgress();
  if (!video.paused) startTick();

  if (typeof options.startTime === "number" && options.startTime > 0) {
    const applyStart = () => seekTo(options.startTime ?? 0);
    if (video.readyState >= 1) applyStart();
    else on(video, "loadedmetadata", applyStart, { once: true });
  }

  on(video, "play", () => {
    reflectPlay();
    startTick();
    showControls();
  });
  on(video, "pause", () => {
    reflectPlay();
    stopTick();
    setBuffering(false);
    player.classList.add("is-active");
    clearInactivity();
  });
  on(video, "ended", () => {
    reflectPlay();
    stopTick();
    player.classList.add("is-active");
  });
  on(video, "volumechange", reflectVolume);
  on(video, "loadedmetadata", updateDuration);
  on(video, "durationchange", updateDuration);
  on(video, "timeupdate", () => {
    updateProgress();
    if (!video.paused) setBuffering(false);
  });
  on(video, "progress", () => {
    updateBuffered();
    if (hasPlayableBuffer()) setBuffering(false);
  });
  on(video, "waiting", () => setBuffering(shouldShowBuffering()));
  on(video, "stalled", () => setBuffering(shouldShowBuffering()));
  on(video, "seeking", () => setBuffering(true));
  on(video, "playing", () => setBuffering(false));
  on(video, "canplay", () => setBuffering(false));
  on(video, "seeked", () => setBuffering(false));

  playBtn && on(playBtn, "click", togglePlay);
  bigPlay && on(bigPlay, "click", togglePlay);
  muteBtn && on(muteBtn, "click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
    showControls();
  });
  fsBtn && on(fsBtn, "click", toggleFullscreen);
  pipBtn && on(pipBtn, "click", () => void togglePip());

  on(player, "pointerdown", (event) => {
    lastPointerType = (event as PointerEvent).pointerType || "mouse";
  });
  on(video, "click", () => {
    if (lastPointerType === "touch") {
      if (player.classList.contains("is-active")) player.classList.remove("is-active");
      else showControls();
      return;
    }
    togglePlay();
  });
  on(video, "dblclick", () => {
    if (lastPointerType !== "touch") toggleFullscreen();
  });

  on(player, "pointermove", () => showControls());
  on(player, "pointerleave", () => {
    if (!video.paused) player.classList.remove("is-active");
  });
  on(player, "focusin", showControls);

  if (timeline && rail) {
    let scrubbing = false;
    const seekFromEvent = (event: PointerEvent) => seekTo(fractionFromPointer(event.clientX, rail) * (video.duration || 0));
    on(timeline, "pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      scrubbing = true;
      player.classList.add("is-scrubbing");
      capturePointer(timeline, pointerEvent.pointerId);
      seekFromEvent(pointerEvent);
      showControls();
    });
    on(timeline, "pointermove", (event) => {
      const pointerEvent = event as PointerEvent;
      const fraction = fractionFromPointer(pointerEvent.clientX, rail);
      if (hoverfill) hoverfill.style.width = `${fraction * 100}%`;
      if (scrubbing) seekFromEvent(pointerEvent);
    });
    on(timeline, "pointerup", (event) => {
      const pointerEvent = event as PointerEvent;
      scrubbing = false;
      player.classList.remove("is-scrubbing");
      releasePointer(timeline, pointerEvent.pointerId);
    });
    on(timeline, "pointercancel", () => {
      scrubbing = false;
      player.classList.remove("is-scrubbing");
    });
    on(timeline, "pointerleave", () => {
      if (hoverfill) hoverfill.style.width = "0%";
    });
    on(timeline, "keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      const duration = video.duration || 0;
      if (keyboardEvent.key === "ArrowRight") {
        seekTo(video.currentTime + SEEK_STEP_SECONDS);
      } else if (keyboardEvent.key === "ArrowLeft") {
        seekTo(video.currentTime - SEEK_STEP_SECONDS);
      } else if (keyboardEvent.key === "Home") {
        seekTo(0);
      } else if (keyboardEvent.key === "End") {
        seekTo(duration);
      } else {
        return;
      }
      keyboardEvent.preventDefault();
      showControls();
    });
  }

  if (volSlider && volRail) {
    let adjusting = false;
    const setVolumeFromEvent = (event: PointerEvent) => {
      const fraction = fractionFromPointer(event.clientX, volRail);
      video.muted = fraction === 0;
      video.volume = fraction;
    };
    on(volSlider, "pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      adjusting = true;
      capturePointer(volSlider, pointerEvent.pointerId);
      setVolumeFromEvent(pointerEvent);
      showControls();
    });
    on(volSlider, "pointermove", (event) => {
      if (adjusting) setVolumeFromEvent(event as PointerEvent);
    });
    on(volSlider, "pointerup", (event) => {
      adjusting = false;
      releasePointer(volSlider, (event as PointerEvent).pointerId);
    });
    on(volSlider, "keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key === "ArrowRight" || keyboardEvent.key === "ArrowUp") {
        video.muted = false;
        video.volume = clamp(video.volume + VOLUME_STEP, 0, 1);
      } else if (keyboardEvent.key === "ArrowLeft" || keyboardEvent.key === "ArrowDown") {
        video.volume = clamp(video.volume - VOLUME_STEP, 0, 1);
        if (video.volume === 0) video.muted = true;
      } else {
        return;
      }
      keyboardEvent.preventDefault();
    });
  }

  on(player, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.target as HTMLElement | null;
    if (target && (target === timeline || target === volSlider)) return;
    switch (keyboardEvent.key) {
      case " ":
      case "k":
        togglePlay();
        break;
      case "ArrowRight":
        seekTo(video.currentTime + SEEK_STEP_SECONDS);
        break;
      case "ArrowLeft":
        seekTo(video.currentTime - SEEK_STEP_SECONDS);
        break;
      case "l":
        seekTo(video.currentTime + SEEK_JUMP_SECONDS);
        break;
      case "j":
        seekTo(video.currentTime - SEEK_JUMP_SECONDS);
        break;
      case "ArrowUp":
        video.muted = false;
        video.volume = clamp(video.volume + VOLUME_STEP, 0, 1);
        break;
      case "ArrowDown":
        video.volume = clamp(video.volume - VOLUME_STEP, 0, 1);
        break;
      case "m":
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
        break;
      case "f":
        toggleFullscreen();
        break;
      case "Home":
        seekTo(0);
        break;
      case "End":
        seekTo(video.duration || 0);
        break;
      default:
        if (keyboardEvent.key >= "0" && keyboardEvent.key <= "9") {
          const fraction = Number(keyboardEvent.key) / 10;
          seekTo((video.duration || 0) * fraction);
          break;
        }
        return;
    }
    keyboardEvent.preventDefault();
    showControls();
  });

  const onFullscreenChange = () => {
    player.classList.toggle("is-fullscreen", isFullscreen());
    fsBtn?.setAttribute("aria-label", isFullscreen() ? "Exit full screen" : "Full screen");
  };
  on(document, "fullscreenchange", onFullscreenChange);
  on(document, "webkitfullscreenchange", onFullscreenChange);

  if (supportsPip) {
    on(video, "enterpictureinpicture", () => player.classList.add("is-pip"));
    on(video, "leavepictureinpicture", () => player.classList.remove("is-pip"));
  }

  player.classList.add("is-active");
  scheduleHide();

  return () => {
    for (const cleanup of cleanups) cleanup();
    clearInactivity();
    if (rafId) window.cancelAnimationFrame(rafId);
  };
}

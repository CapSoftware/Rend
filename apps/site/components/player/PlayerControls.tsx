export function PlayerControls() {
  return (
    <div className="rend-ctrl" data-rend-controls aria-hidden="true">
      <div className="rend-ctrl__gradient" />

      <button className="rend-ctrl__bigplay" type="button" data-rend-bigplay aria-label="Play">
        <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
          <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.79-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z" fill="currentColor" />
        </svg>
      </button>

      <div className="rend-ctrl__spinner" data-rend-spinner aria-hidden="true">
        <svg viewBox="0 0 50 50" width="48" height="48">
          <circle className="rend-ctrl__spinner-track" cx="25" cy="25" r="20" fill="none" strokeWidth="4" />
          <circle className="rend-ctrl__spinner-head" cx="25" cy="25" r="20" fill="none" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </div>

      <div className="rend-ctrl__bar" data-rend-bar>
        <div
          className="rend-ctrl__timeline"
          data-rend-timeline
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <div className="rend-ctrl__rail" data-rend-rail>
            <div className="rend-ctrl__buffered" data-rend-buffered />
            <div className="rend-ctrl__hoverfill" data-rend-hoverfill />
            <div className="rend-ctrl__played" data-rend-progress>
              <span className="rend-ctrl__thumb" />
            </div>
          </div>
        </div>

        <div className="rend-ctrl__buttons">
          <button className="rend-ctrl__btn rend-ctrl__btn--play" type="button" data-rend-play aria-label="Play">
            <svg className="rend-ctrl__i rend-ctrl__i--play" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.79-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z" fill="currentColor" />
            </svg>
            <svg className="rend-ctrl__i rend-ctrl__i--pause" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z" fill="currentColor" />
            </svg>
          </button>

          <div className="rend-ctrl__vol" data-rend-vol>
            <button className="rend-ctrl__btn rend-ctrl__btn--mute" type="button" data-rend-mute aria-label="Mute">
              <svg className="rend-ctrl__i rend-ctrl__i--vol-high" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M4 9.5v5a1 1 0 0 0 1 1h3l4 3.2a1 1 0 0 0 1.6-.8V5.1a1 1 0 0 0-1.6-.8L8 7.5H5a1 1 0 0 0-1 1Z" fill="currentColor" />
                <path d="M16.5 8.5a4.5 4.5 0 0 1 0 7M19 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <svg className="rend-ctrl__i rend-ctrl__i--vol-low" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M4 9.5v5a1 1 0 0 0 1 1h3l4 3.2a1 1 0 0 0 1.6-.8V5.1a1 1 0 0 0-1.6-.8L8 7.5H5a1 1 0 0 0-1 1Z" fill="currentColor" />
                <path d="M16.5 9.5a4 4 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <svg className="rend-ctrl__i rend-ctrl__i--vol-off" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M4 9.5v5a1 1 0 0 0 1 1h3l4 3.2a1 1 0 0 0 1.6-.8V5.1a1 1 0 0 0-1.6-.8L8 7.5H5a1 1 0 0 0-1 1Z" fill="currentColor" />
                <path d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
            <div
              className="rend-ctrl__volslider"
              data-rend-volume
              role="slider"
              tabIndex={0}
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={100}
            >
              <div className="rend-ctrl__volrail" data-rend-volrail>
                <div className="rend-ctrl__volfill" data-rend-volfill>
                  <span className="rend-ctrl__volthumb" />
                </div>
              </div>
            </div>
          </div>

          <div className="rend-ctrl__time">
            <span data-rend-current>0:00</span>
            <span className="rend-ctrl__time-sep">/</span>
            <span data-rend-duration>0:00</span>
          </div>

          <div className="rend-ctrl__spacer" />

          <button className="rend-ctrl__btn rend-ctrl__btn--pip" type="button" data-rend-pip aria-label="Picture in picture" hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M3.5 5.5h17a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="3" y="12" width="9" height="6.5" rx="1.2" fill="currentColor" />
            </svg>
          </button>

          <button className="rend-ctrl__btn rend-ctrl__btn--fs" type="button" data-rend-fullscreen aria-label="Full screen">
            <svg className="rend-ctrl__i rend-ctrl__i--fs-enter" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg className="rend-ctrl__i rend-ctrl__i--fs-exit" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M9 4v4a1 1 0 0 1-1 1H4M15 4v4a1 1 0 0 0 1 1h4M9 20v-4a1 1 0 0 0-1-1H4M15 20v-4a1 1 0 0 1 1-1h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

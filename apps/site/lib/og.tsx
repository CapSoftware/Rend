import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ogSize = { width: 1200, height: 630 };

const INK = "#161513";
const MUTED = "#6f6a61";
const LINE = "#e7e3da";
const BG = "#fcfbf8";
const GHOST = "#f0ece2";

type OgFont = {
  name: string;
  data: Buffer;
  weight: 400 | 500;
  style: "normal";
};

let fontsPromise: Promise<OgFont[]> | null = null;

function loadFonts(): Promise<OgFont[]> {
  if (!fontsPromise) {
    const dir = join(process.cwd(), "assets/fonts");
    fontsPromise = Promise.all([
      readFile(join(dir, "HeadlandOne-Regular.ttf")),
      readFile(join(dir, "Inter-Regular.ttf")),
      readFile(join(dir, "Inter-Medium.ttf")),
    ]).then(([headland, inter, interMedium]) => [
      { name: "Headland One", data: headland, weight: 400, style: "normal" },
      { name: "Inter", data: inter, weight: 400, style: "normal" },
      { name: "Inter", data: interMedium, weight: 500, style: "normal" },
    ]);
  }
  return fontsPromise;
}

function RendLogo({ height }: { height: number }) {
  const width = (372 / 135) * height;
  return (
    <svg width={width} height={height} viewBox="0 0 372 135" fill="none">
      <path
        d="M128.986 98.7039C129.546 99.649 130.212 100.314 130.982 100.699C131.752 101.049 132.872 101.224 134.342 101.224C135.847 101.224 137.72 100.944 139.96 100.384L139.383 107H108.404L109.034 101.224C112.639 101.154 114.932 100.209 115.912 98.3888C116.752 96.9186 117.172 93.6632 117.172 88.6225L117.12 41.3134C117.12 37.8829 116.962 35.7651 116.647 34.96C116.017 33.4898 114.582 32.7547 112.342 32.7547C110.556 32.7547 108.736 32.9647 106.881 33.3848L107.721 26.6639H122.843L144.161 25.8763C157.043 25.8763 165.199 29.8843 168.629 37.9004C169.68 40.4208 170.205 43.2737 170.205 46.4591C170.205 49.6096 169.627 52.4975 168.472 55.1228C167.317 57.7482 165.829 60.0585 164.009 62.0538C160.368 66.0443 156.133 68.6172 151.302 69.7723C154.802 71.5576 158.583 75.8807 162.644 82.7416L168.682 93.0331C171.797 98.1788 174.23 100.752 175.98 100.752C177.346 100.822 178.833 100.594 180.443 100.069L180.181 107H172.2C166.914 107 162.644 105.197 159.388 101.592C157.778 99.5615 156.36 96.9361 155.135 93.7157L152.247 86.3646C150.952 83.1442 149.412 80.3613 147.626 78.016C145.841 75.6357 144.336 74.0429 143.111 73.2378C140.871 71.8026 137.37 71.085 132.609 71.085H128.199V92.298C128.199 95.6234 128.461 97.7587 128.986 98.7039ZM147.836 33.0698C145.596 32.3347 143.601 31.9671 141.851 31.9671H135.34C132.714 31.9671 130.334 32.2471 128.199 32.8072V64.7842H140.853C145.614 64.7141 149.587 63.2439 152.772 60.3735C156.168 57.2581 157.865 53.1625 157.865 48.0868C157.865 40.1757 154.522 35.1701 147.836 33.0698ZM211.664 98.8089C218.595 98.3538 224.704 96.6911 229.989 93.8207L232.3 98.2313C227.014 102.607 220.993 105.6 214.237 107.21C212.207 107.665 210.352 107.893 208.671 107.893C195.475 107.893 187.161 102.064 183.73 90.4077C182.61 86.6622 182.05 82.3041 182.05 77.3334C182.05 72.3277 182.855 67.7246 184.466 63.524C186.111 59.3234 188.264 55.7529 190.924 52.8125C193.619 49.8371 196.7 47.5443 200.165 45.934C203.631 44.3238 207.219 43.5187 210.929 43.5187C225.806 43.5187 233.245 52.0249 233.245 69.0372V69.5623C233.245 74.0079 232.72 76.2307 231.67 76.2307H193.024C193.024 83.5468 194.634 89.1125 197.855 92.9281C201.11 96.7436 205.713 98.7039 211.664 98.8089ZM221.273 69.5098C221.308 68.7747 221.326 68.2146 221.326 67.8296V66.0968C221.326 57.8707 219.05 52.8125 214.5 50.9222C212.854 50.2221 211.087 49.8721 209.196 49.8721C207.341 49.8721 205.766 50.1521 204.471 50.7122C203.176 51.2723 201.95 52.0424 200.795 53.0225C199.675 54.0027 198.643 55.1578 197.697 56.488C196.752 57.7832 195.93 59.2184 195.23 60.7936C193.759 64.0491 193.024 67.3745 193.024 70.77L221.273 69.5098ZM239.21 101.434C242.115 101.434 244.058 100.699 245.038 99.2289C246.158 97.5487 246.718 94.0832 246.718 88.8325V63.4715C246.718 59.2709 246.211 56.488 245.195 55.1228C244.18 53.7226 241.835 53.0225 238.159 53.0225L239 46.4066L257.797 43.5712C257.412 46.4066 257.22 49.417 257.22 52.6025C261.7 48.927 266.391 46.2666 271.292 44.6214C273.392 43.8863 275.562 43.5187 277.802 43.5187C280.043 43.5187 282.213 43.8513 284.313 44.5163C286.449 45.1814 288.304 46.2666 289.879 47.7718C293.345 51.0273 295.077 55.8754 295.077 62.3163C295.077 66.2369 294.955 70.0699 294.71 73.8154C294.045 85.052 293.835 91.8954 294.08 94.3457C294.36 96.7961 294.675 98.4238 295.025 99.2289C295.69 100.699 296.88 101.434 298.595 101.434C300.241 101.434 301.728 101.224 303.058 100.804L302.271 107H275.387L276.332 101.434C279.238 101.434 281.233 100.804 282.318 99.544C282.773 99.0189 283.106 98.3013 283.316 97.3912C283.561 96.446 283.753 95.2559 283.893 93.8207C284.068 92.3855 284.208 90.6527 284.313 88.6225C284.523 84.4919 284.628 79.8187 284.628 74.603C284.628 69.3523 284.523 65.5368 284.313 63.1564C284.138 60.7411 283.683 58.7983 282.948 57.3281C281.548 54.4577 278.468 53.0225 273.707 53.0225C269.296 53.0225 264.641 54.5277 259.74 57.5382L257.22 59.0609V94.3457C257.22 97.4962 257.465 99.4039 257.955 100.069C258.445 100.734 259.005 101.137 259.635 101.277C260.265 101.382 260.965 101.434 261.735 101.434C263.521 101.434 265.183 101.242 266.723 100.857L265.831 107H238.37L239.21 101.434ZM328.609 44.8314C331.269 43.9563 334.349 43.5187 337.85 43.5187C341.385 43.5187 344.973 44.0088 348.614 44.9889V43.9388C348.614 35.6776 348.474 31.127 348.194 30.2869C347.914 29.4118 347.564 28.7817 347.144 28.3966C346.759 28.0116 346.233 27.679 345.568 27.399C344.938 27.1189 344.238 26.9089 343.468 26.7689C342.488 26.6289 340.79 26.5589 338.375 26.5589H337.377L338.165 20.573L360.008 17.5276C360.008 17.8427 359.973 18.1052 359.903 18.3152C359.868 18.5252 359.798 19.0153 359.693 19.7854C359.588 20.5205 359.483 21.7982 359.378 23.6185C359.098 28.4841 358.958 35.03 358.958 43.2562V91.1428C358.958 93.8732 359.255 95.7984 359.85 96.9186C360.48 98.0388 361.356 98.5988 362.476 98.5988C363.946 98.5988 365.626 98.2663 367.516 97.6012L369.039 97.1286C368.969 97.5487 368.899 98.1438 368.829 98.9139C368.794 99.649 368.742 100.419 368.672 101.224C368.602 102.029 368.549 102.904 368.514 103.85L352.027 107.945C351.642 107.77 351.099 106.702 350.399 104.742C349.734 102.782 349.279 101.347 349.034 100.437C344.588 103.587 339.863 105.81 334.857 107.105C333.107 107.56 330.989 107.788 328.503 107.788C326.018 107.788 323.305 107.158 320.365 105.897C317.424 104.637 314.887 102.764 312.751 100.279C308.096 94.9933 305.768 87.6948 305.768 78.3835C305.768 72.2927 307.168 66.5169 309.968 61.0561C314.169 52.83 320.382 47.4218 328.609 44.8314ZM332.389 98.1788C334.349 98.1088 336.24 97.8812 338.06 97.4962C339.88 97.1111 341.525 96.6736 342.996 96.1835C346.111 95.1684 348.019 94.3107 348.719 93.6106L348.614 93.6632V55.4904C347.074 53.18 344.116 51.5523 339.74 50.6072C338.48 50.3272 336.835 50.1871 334.804 50.1871C332.774 50.1871 330.569 50.6597 328.188 51.6048C325.843 52.515 323.83 54.0202 322.15 56.1205C318.65 60.4961 316.899 67.357 316.899 76.7033C316.899 83.0042 318.492 88.2374 321.678 92.403C324.723 96.3585 328.293 98.2838 332.389 98.1788Z"
        fill={INK}
      />
      <path d="M0 27L30.3041 44.1723V90.6385L0 107.811V27Z" fill={INK} />
      <path d="M41.4155 48.2128L74.75 67.4054L41.4155 86.598V48.2128Z" fill={INK} />
    </svg>
  );
}

function RendMark({ height, fill }: { height: number; fill: string }) {
  const width = (75 / 135) * height;
  return (
    <svg width={width} height={height} viewBox="0 0 75 135" fill="none">
      <path d="M0 27L30.3041 44.1723V90.6385L0 107.811V27Z" fill={fill} />
      <path d="M41.4155 48.2128L74.75 67.4054L41.4155 86.598V48.2128Z" fill={fill} />
    </svg>
  );
}

function Squiggle({ width }: { width: number }) {
  const height = (20 / 240) * width;
  return (
    <svg width={width} height={height} viewBox="0 0 240 20" fill="none">
      <path
        d="M4 14 C40 5 80 16 120 8 C160 1 200 13 236 6"
        stroke={INK}
        strokeWidth={6}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function Sparkle({
  x,
  y,
  size,
  opacity,
}: {
  x: number;
  y: number;
  size: number;
  opacity: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ position: "absolute", left: x, top: y, opacity }}
    >
      <path
        d="M12 3 L12 21 M3 12 L21 12"
        stroke={INK}
        strokeWidth={3.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

function Frame() {
  return (
    <div
      style={{
        position: "absolute",
        top: 28,
        left: 28,
        right: 28,
        bottom: 28,
        border: `2px solid ${LINE}`,
        borderRadius: 30,
      }}
    />
  );
}

function titleSize(title: string): number {
  if (title.length <= 18) return 84;
  if (title.length <= 30) return 72;
  if (title.length <= 48) return 60;
  return 50;
}

export async function renderOgImage(page?: { title: string; subtitle?: string }) {
  const fonts = await loadFonts();

  const element = page ? (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        backgroundColor: BG,
        fontFamily: "Inter",
        padding: "76px 84px",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 28,
          left: 28,
          right: 28,
          bottom: 28,
          borderRadius: 30,
          overflow: "hidden",
          display: "flex",
        }}
      >
        <div style={{ position: "absolute", right: -98, top: 67, display: "flex" }}>
          <RendMark height={440} fill={GHOST} />
        </div>
      </div>
      <Frame />
      <Sparkle x={1016} y={92} size={26} opacity={0.4} />
      <Sparkle x={944} y={404} size={17} opacity={0.25} />
      <div style={{ display: "flex" }}>
        <RendLogo height={62} />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "center",
          paddingBottom: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: "Headland One",
            fontSize: titleSize(page.title),
            lineHeight: 1.16,
            letterSpacing: "-0.01em",
            color: INK,
            maxWidth: 880,
          }}
        >
          {page.title}
        </div>
        <div style={{ display: "flex", marginTop: 26, marginLeft: 6 }}>
          <Squiggle width={170} />
        </div>
        {page.subtitle ? (
          <div
            style={{
              display: "flex",
              marginTop: 30,
              fontSize: 27,
              lineHeight: 1.45,
              color: MUTED,
              maxWidth: 760,
            }}
          >
            {page.subtitle}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 22,
        }}
      >
        <div style={{ display: "flex", color: INK, fontWeight: 500 }}>Rend.so</div>
        <div style={{ display: "flex", color: MUTED }}>
          Open source · A Cap company
        </div>
      </div>
    </div>
  ) : (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        backgroundColor: BG,
        fontFamily: "Inter",
      }}
    >
      <Frame />
      <Sparkle x={196} y={148} size={26} opacity={0.42} />
      <Sparkle x={262} y={224} size={16} opacity={0.25} />
      <Sparkle x={968} y={150} size={20} opacity={0.3} />
      <Sparkle x={1006} y={430} size={26} opacity={0.42} />
      <Sparkle x={170} y={444} size={18} opacity={0.25} />
      <div style={{ display: "flex" }}>
        <RendLogo height={118} />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          marginTop: 52,
          fontFamily: "Headland One",
          fontSize: 44,
          lineHeight: 1.2,
          letterSpacing: "-0.01em",
          color: INK,
        }}
      >
        <div style={{ display: "flex" }}>Video infrastructure, built for&nbsp;</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ display: "flex" }}>speed</div>
          <div style={{ display: "flex", marginTop: 6, marginBottom: -16 }}>
            <Squiggle width={128} />
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 40,
          fontSize: 25,
          lineHeight: 1.5,
          color: MUTED,
          maxWidth: 720,
          textAlign: "center",
        }}
      >
        One API call to upload, one URL that plays instantly anywhere in the world.
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 66,
          display: "flex",
          alignItems: "center",
          fontSize: 21,
          color: MUTED,
        }}
      >
        <div style={{ display: "flex", color: INK, fontWeight: 500 }}>Rend.so</div>
        <div style={{ display: "flex", margin: "0 14px" }}>·</div>
        <div style={{ display: "flex" }}>Open source</div>
        <div style={{ display: "flex", margin: "0 14px" }}>·</div>
        <div style={{ display: "flex" }}>A Cap company</div>
      </div>
    </div>
  );

  return new ImageResponse(element, { ...ogSize, fonts });
}

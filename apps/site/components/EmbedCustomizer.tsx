"use client";

import {
  ChevronDown,
  Clock,
  Code,
  Link2,
  Monitor,
  Palette,
  Play,
  Repeat,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  Square,
  Tv,
  Volume2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { CopyButton } from "@/components/dashboard";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const DEFAULT_ACCENT = "#b5872b";

const ACCENT_PRESETS = [
  "#b5872b",
  "#e5484d",
  "#f76b15",
  "#f5b800",
  "#46a758",
  "#12a594",
  "#0ea5e9",
  "#3e63dd",
  "#6e56cf",
  "#d6409f",
  "#e93d82",
  "#161513",
];

type RatioKey = "16:9" | "9:16" | "1:1" | "4:3";

const RATIOS: Record<RatioKey, { label: string; w: number; h: number; Icon: ComponentType<{ className?: string }> }> = {
  "16:9": { label: "Wide", w: 16, h: 9, Icon: Monitor },
  "9:16": { label: "Vertical", w: 9, h: 16, Icon: Smartphone },
  "1:1": { label: "Square", w: 1, h: 1, Icon: Square },
  "4:3": { label: "Classic", w: 4, h: 3, Icon: Tv },
};

type EngineMode = "auto" | "mse" | "native";
type StartupMode = "hls" | "opener";
type SizeMode = "responsive" | "fixed";
type CodeTab = "html" | "url";

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseStartSeconds(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return value > 0 && value < 86_400 ? value : null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d{1,2}$/.test(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return seconds > 0 && seconds < 86_400 ? seconds : null;
}

function normalizeHex(value: string): string | null {
  const cleaned = value.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 3) {
    return `#${cleaned
      .split("")
      .map((char) => char + char)
      .join("")
      .toLowerCase()}`;
  }
  if (cleaned.length === 6) return `#${cleaned.toLowerCase()}`;
  return null;
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = normalizeHex(hex) ?? DEFAULT_ACCENT;
  const value = normalized.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{children}</p>;
}

function GroupCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card">
      <header className="border-b border-line-soft px-4 py-3 sm:px-5">
        <h3 className="font-head text-[15px] leading-tight text-ink">{title}</h3>
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function GroupCardWithActions({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3 sm:px-5">
        <h3 className="font-head text-[15px] leading-tight text-ink">{title}</h3>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function SwitchRow({
  icon,
  label,
  hint,
  checked,
  onCheckedChange,
  accent,
}: {
  icon: ReactNode;
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  accent: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
          <span className="text-faint">{icon}</span>
          {label}
        </div>
        {hint ? <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        style={checked ? { backgroundColor: accent } : undefined}
      />
    </div>
  );
}

export default function EmbedCustomizer({
  origin,
  embedPath,
  assetId,
  previewable,
  disabled = false,
}: {
  origin: string;
  embedPath: string;
  assetId: string;
  previewable: boolean;
  disabled?: boolean;
}) {
  const [autoplay, setAutoplay] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [controls, setControls] = useState(true);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [startTime, setStartTime] = useState("");
  const [ratioKey, setRatioKey] = useState<RatioKey>("16:9");
  const [sizeMode, setSizeMode] = useState<SizeMode>("responsive");
  const [widthInput, setWidthInput] = useState("640");
  const [engine, setEngine] = useState<EngineMode>("auto");
  const [startup, setStartup] = useState<StartupMode>("hls");
  const [codeTab, setCodeTab] = useState<CodeTab>("html");
  const [hexDraft, setHexDraft] = useState(DEFAULT_ACCENT.replace(/^#/, ""));
  const [previewUrl, setPreviewUrl] = useState(embedPath);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const startFieldId = useId();
  const widthFieldId = useId();
  const hexFieldId = useId();

  const ratio = RATIOS[ratioKey];
  const fixedWidth = clampInt(Number(widthInput) || 0, 120, 3840);
  const fixedHeight = clampInt((fixedWidth * ratio.h) / ratio.w, 1, 100_000);
  const startSeconds = useMemo(() => parseStartSeconds(startTime), [startTime]);

  const buildQuery = useCallback(
    (includeAccent: boolean) => {
      const params = new URLSearchParams();
      if (autoplay) params.set("autoplay", "1");
      if (muted !== autoplay) params.set("muted", muted ? "1" : "0");
      if (loop) params.set("loop", "1");
      if (!controls) params.set("controls", "0");
      if (includeAccent && accent.toLowerCase() !== DEFAULT_ACCENT) {
        params.set("accent", accent.replace(/^#/, ""));
      }
      if (startSeconds) params.set("t", String(startSeconds));
      if (engine !== "auto") params.set("engine", engine);
      if (startup !== "hls") params.set("startup", startup);
      return params.toString();
    },
    [accent, autoplay, controls, engine, loop, muted, startSeconds, startup],
  );

  const fullQuery = buildQuery(true);
  const structuralQuery = buildQuery(false);
  const baseUrl = origin ? `${origin}${embedPath}` : embedPath;
  const embedUrl = fullQuery ? `${baseUrl}?${fullQuery}` : baseUrl;
  const previewRelative = structuralQuery ? `${embedPath}?${structuralQuery}` : embedPath;

  const responsivePct = useMemo(() => {
    const pct = (ratio.h / ratio.w) * 100;
    return Number.isInteger(pct) ? String(pct) : pct.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }, [ratio]);

  const iframeSnippet = useMemo(() => {
    if (sizeMode === "responsive") {
      return [
        `<div style="position:relative;width:100%;padding-top:${responsivePct}%">`,
        `  <iframe`,
        `    src="${embedUrl}"`,
        `    style="position:absolute;inset:0;width:100%;height:100%;border:0"`,
        `    allow="autoplay; fullscreen; picture-in-picture"`,
        `    allowfullscreen`,
        `  ></iframe>`,
        `</div>`,
      ].join("\n");
    }
    return [
      `<iframe`,
      `  src="${embedUrl}"`,
      `  width="${fixedWidth}"`,
      `  height="${fixedHeight}"`,
      `  style="border:0"`,
      `  allow="autoplay; fullscreen; picture-in-picture"`,
      `  allowfullscreen`,
      `></iframe>`,
    ].join("\n");
  }, [embedUrl, fixedHeight, fixedWidth, responsivePct, sizeMode]);

  const codeValue = codeTab === "html" ? iframeSnippet : embedUrl;

  const applyAccent = useCallback(() => {
    const node = iframeRef.current?.contentDocument?.querySelector(".rend-player") as HTMLElement | null;
    if (node) node.style.setProperty("--rend-accent", accent);
  }, [accent]);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewUrl(previewRelative), 320);
    return () => window.clearTimeout(timer);
  }, [previewRelative]);

  useEffect(() => {
    applyAccent();
  }, [applyAccent, previewUrl]);

  useEffect(() => {
    setHexDraft(accent.replace(/^#/, ""));
  }, [accent]);

  const handleAutoplay = useCallback((next: boolean) => {
    setAutoplay(next);
    if (next) setMuted(true);
  }, []);

  const handleHexChange = useCallback((value: string) => {
    const cleaned = value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    setHexDraft(cleaned);
    const normalized = normalizeHex(cleaned);
    if (normalized) setAccent(normalized);
  }, []);

  const resetAll = useCallback(() => {
    setAutoplay(false);
    setMuted(false);
    setLoop(false);
    setControls(true);
    setAccent(DEFAULT_ACCENT);
    setStartTime("");
    setRatioKey("16:9");
    setSizeMode("responsive");
    setWidthInput("640");
    setEngine("auto");
    setStartup("hls");
  }, []);

  const previewMaxWidth = ratio.h > ratio.w ? 248 : ratio.w === ratio.h ? 360 : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className="font-head text-[16px] leading-tight text-ink">Customize your player</span>
        <p className="mt-1 text-[13px] text-muted">Adjust the look and behavior, then grab the embed code.</p>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <div className="order-2 flex flex-col gap-4 lg:order-1">
          <GroupCard title="Appearance">
            <div className="pb-4">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                <Palette className="size-4 text-faint" />
                Accent color
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {ACCENT_PRESETS.map((color) => {
                  const selected = accent.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use accent ${color}`}
                      aria-pressed={selected}
                      onClick={() => setAccent(color)}
                      className={cn(
                        "size-7 rounded-full border border-black/10 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25",
                        selected && "scale-110 ring-2 ring-ink ring-offset-2 ring-offset-card",
                      )}
                      style={{ backgroundColor: color }}
                    />
                  );
                })}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <label
                  htmlFor={hexFieldId}
                  className="relative inline-flex size-9 cursor-pointer overflow-hidden rounded-md border border-line"
                >
                  <span className="absolute inset-0" style={{ backgroundColor: accent }} />
                  <input
                    type="color"
                    value={accent}
                    onChange={(event) => setAccent(event.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Pick a custom accent color"
                  />
                </label>
                <div className="inline-flex h-9 items-center gap-1 rounded-md border border-line bg-bg-sunken px-2.5 font-mono text-[12.5px] text-ink-soft">
                  <span className="text-faint">#</span>
                  <input
                    id={hexFieldId}
                    value={hexDraft}
                    onChange={(event) => handleHexChange(event.target.value)}
                    className="w-[68px] bg-transparent uppercase outline-none"
                    maxLength={6}
                    spellCheck={false}
                    aria-label="Accent hex value"
                  />
                </div>
              </div>
            </div>
            <div className="border-t border-line-soft pt-1">
              <SwitchRow
                icon={<SlidersHorizontal className="size-4" />}
                label="Player controls"
                hint="Show the play bar, scrubber and volume."
                checked={controls}
                onCheckedChange={setControls}
                accent={accent}
              />
            </div>
          </GroupCard>

          <GroupCard title="Playback">
            <div className="divide-y divide-line-soft">
              <SwitchRow
                icon={<Play className="size-4" />}
                label="Autoplay"
                hint={
                  autoplay && !muted
                    ? "Most browsers block autoplay with sound."
                    : "Start playing as soon as it loads."
                }
                checked={autoplay}
                onCheckedChange={handleAutoplay}
                accent={accent}
              />
              <SwitchRow
                icon={<Volume2 className="size-4" />}
                label="Start muted"
                checked={muted}
                onCheckedChange={setMuted}
                accent={accent}
              />
              <SwitchRow
                icon={<Repeat className="size-4" />}
                label="Loop"
                checked={loop}
                onCheckedChange={setLoop}
                accent={accent}
              />
              <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
                <Label htmlFor={startFieldId} className="text-[13.5px]">
                  <Clock className="size-4 text-faint" />
                  Start at
                </Label>
                <Input
                  id={startFieldId}
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                  placeholder="0:00"
                  inputMode="numeric"
                  className="h-9 w-20 text-center font-mono text-[12.5px]"
                />
              </div>
            </div>
          </GroupCard>

          <GroupCard title="Embed size">
            <div className="flex flex-col gap-4">
              <div>
                <FieldLabel>Aspect ratio</FieldLabel>
                <ToggleGroup
                  type="single"
                  value={ratioKey}
                  onValueChange={(value) => value && setRatioKey(value as RatioKey)}
                >
                  {(Object.keys(RATIOS) as RatioKey[]).map((key) => {
                    const Icon = RATIOS[key].Icon;
                    return (
                      <ToggleGroupItem key={key} value={key} aria-label={RATIOS[key].label}>
                        <Icon className="size-3.5" />
                        {RATIOS[key].label}
                      </ToggleGroupItem>
                    );
                  })}
                </ToggleGroup>
              </div>
              <div>
                <FieldLabel>Sizing</FieldLabel>
                <div className="flex flex-wrap items-center gap-3">
                  <ToggleGroup
                    type="single"
                    value={sizeMode}
                    onValueChange={(value) => value && setSizeMode(value as SizeMode)}
                  >
                    <ToggleGroupItem value="responsive">Responsive</ToggleGroupItem>
                    <ToggleGroupItem value="fixed">Fixed</ToggleGroupItem>
                  </ToggleGroup>
                  {sizeMode === "fixed" ? (
                    <div className="inline-flex items-center gap-2 text-[12.5px] text-muted">
                      <Label htmlFor={widthFieldId} className="sr-only">
                        Embed width in pixels
                      </Label>
                      <Input
                        id={widthFieldId}
                        type="text"
                        inputMode="numeric"
                        value={widthInput}
                        onChange={(event) => setWidthInput(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                        onBlur={() => setWidthInput(String(fixedWidth))}
                        className="h-9 w-24 text-center font-mono text-[12.5px]"
                      />
                      <span className="font-mono">x {fixedHeight}px</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </GroupCard>

          <details className="group overflow-hidden rounded-xl border border-line bg-card">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden">
              <span className="font-head text-[15px] leading-tight text-ink">Advanced</span>
              <ChevronDown className="size-4 text-faint transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-line-soft px-4 py-4 sm:px-5">
              <div className="flex flex-col gap-4">
                <div>
                  <FieldLabel>Playback engine</FieldLabel>
                  <ToggleGroup
                    type="single"
                    value={engine}
                    onValueChange={(value) => value && setEngine(value as EngineMode)}
                  >
                    <ToggleGroupItem value="auto">Auto</ToggleGroupItem>
                    <ToggleGroupItem value="mse">MSE</ToggleGroupItem>
                    <ToggleGroupItem value="native">Native</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <div>
                  <FieldLabel>Startup</FieldLabel>
                  <ToggleGroup
                    type="single"
                    value={startup}
                    onValueChange={(value) => value && setStartup(value as StartupMode)}
                  >
                    <ToggleGroupItem value="hls">HLS</ToggleGroupItem>
                    <ToggleGroupItem value="opener">Opener</ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            </div>
          </details>
        </div>

        <div className="order-1 flex flex-col gap-4 lg:order-2 lg:sticky lg:top-4">
          <GroupCardWithActions
            title="Live preview"
            actions={
              !disabled && origin ? (
                <Button href={embedUrl} external variant="secondary" size="sm" className="rounded-md">
                  <Link2 className="size-3.5" />
                  Open
                </Button>
              ) : null
            }
          >
            <div
              className="relative overflow-hidden rounded-xl border border-white/5 p-4 sm:p-5"
              style={{
                backgroundColor: "#0f1115",
                backgroundImage: `radial-gradient(120% 130% at 50% -10%, ${hexToRgba(accent, 0.22)} 0%, rgba(15,17,21,0) 60%)`,
              }}
            >
              <div className="mx-auto w-full" style={previewMaxWidth ? { maxWidth: previewMaxWidth } : undefined}>
                <div
                  className="relative w-full overflow-hidden rounded-lg bg-black shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)]"
                  style={{ aspectRatio: `${ratio.w} / ${ratio.h}` }}
                >
                  {previewable ? (
                    <iframe
                      ref={iframeRef}
                      key={previewUrl}
                      src={previewUrl}
                      onLoad={applyAccent}
                      title={`Embed preview ${assetId}`}
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                      className="absolute inset-0 size-full border-0"
                    />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center px-6 text-center">
                      <p className="text-[12.5px] leading-relaxed text-white/65">
                        {disabled
                          ? "Preview is unavailable while suspended."
                          : "Preview appears once a playable rendition is ready."}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-3 text-center text-[12px] text-muted">
              {sizeMode === "responsive"
                ? `Responsive at ${ratioKey}`
                : `${fixedWidth} x ${fixedHeight}px at ${ratioKey}`}
            </p>
          </GroupCardWithActions>

          <GroupCardWithActions
            title="Embed code"
            actions={
              <ToggleGroup
                type="single"
                value={codeTab}
                onValueChange={(value) => value && setCodeTab(value as CodeTab)}
              >
                <ToggleGroupItem value="html">
                  <Code className="size-3.5" />
                  HTML
                </ToggleGroupItem>
                <ToggleGroupItem value="url">
                  <Link2 className="size-3.5" />
                  URL
                </ToggleGroupItem>
              </ToggleGroup>
            }
          >
            <div className="relative">
              <pre className="max-h-60 overflow-auto rounded-lg border border-line bg-bg-sunken p-3 pr-12 font-mono text-[12px] leading-relaxed text-ink-soft">
                <code className="whitespace-pre-wrap break-all">{codeValue}</code>
              </pre>
              <div className="absolute right-2 top-2">
                <CopyButton value={codeValue} iconOnly label="Copy embed code" disabled={disabled} />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[12px] text-muted">
                {codeTab === "html" ? "Paste into any HTML page." : "Use as a direct link or iframe src."}
              </p>
              <button
                type="button"
                onClick={resetAll}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-muted transition-colors hover:bg-bg-sunken hover:text-ink"
              >
                <RotateCcw className="size-3.5" />
                Reset
              </button>
            </div>
          </GroupCardWithActions>
        </div>
      </div>
    </div>
  );
}

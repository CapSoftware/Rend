"use client";

import { useState } from "react";

type Status = "idle" | "loading" | "done" | "error";

export default function WaitlistForm({ id }: { id?: string }) {
  const [status, setStatus] = useState<Status>("idle");

  if (status === "done") {
    return (
      <p className="mx-auto max-w-[460px] py-[13px] text-center text-[15px] font-medium">
        You&apos;re on the list. See you at launch.
      </p>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email")?.toString().trim();
    if (!email) return;
    setStatus("loading");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) throw new Error("Request failed");
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  return (
    <form
      id={id}
      onSubmit={handleSubmit}
      autoComplete="off"
      className="mx-auto flex max-w-[460px] flex-wrap justify-center gap-2.5"
    >
      <input
        type="email"
        name="email"
        required
        placeholder="you@company.com"
        aria-label="Email address"
        className="min-w-0 flex-1 rounded-full border border-line bg-card px-[18px] py-[13px] text-[15px] outline-none transition placeholder:text-[#b1aa9e] focus:border-ink focus:shadow-[0_0_0_3px_rgba(22,21,19,0.08)] max-sm:w-full max-sm:flex-none"
      />
      <button
        type="submit"
        disabled={status === "loading"}
        className="whitespace-nowrap rounded-full bg-ink px-6 py-[13px] text-[15px] font-medium text-bg transition hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(22,21,19,0.18)] disabled:opacity-60 max-sm:w-full"
      >
        {status === "loading" ? "Joining\u2026" : "Join the waitlist"}
      </button>
      {status === "error" && (
        <p className="w-full text-center text-[13px] text-[#b3433a]">
          Something went wrong, please try again.
        </p>
      )}
    </form>
  );
}

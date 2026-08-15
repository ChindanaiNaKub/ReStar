"use client";

import { useEffect, useState } from "react";

type DigestPreferences = {
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: string;
  itemCount: number;
  paused: boolean;
  nextDeliveryAt: string | null;
};

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function detectedTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatNextDelivery(preferences: DigestPreferences) {
  if (!preferences.nextDeliveryAt) return "Paused — no Digest will be scheduled.";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: preferences.timezone,
  }).format(new Date(preferences.nextDeliveryAt));
}

export default function DigestPreferencesView() {
  const [preferences, setPreferences] = useState<DigestPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/digest/preferences", { headers: { "x-time-zone": detectedTimezone() } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Digest settings could not be loaded.");
        return response.json() as Promise<DigestPreferences>;
      })
      .then(setPreferences)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Digest settings could not be loaded."));
  }, []);

  async function save(next: DigestPreferences) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/digest/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await response.json() as DigestPreferences & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Digest settings could not be saved.");
      setPreferences(body);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Digest settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="settings-error" role="alert">{error}</p>;
  if (!preferences) return <p className="settings-loading" aria-live="polite">Loading Digest settings…</p>;

  return (
    <div className="settings-card">
      <p className="next-delivery"><span>Next expected local delivery</span><strong>{formatNextDelivery(preferences)}</strong></p>
      <form onSubmit={(event) => { event.preventDefault(); void save(preferences); }}>
        <label>
          Day
          <select value={preferences.dayOfWeek} onChange={(event) => setPreferences({ ...preferences, dayOfWeek: Number(event.target.value) })}>
            {days.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
          </select>
        </label>
        <label>
          Time
          <input
            type="time"
            value={`${String(preferences.hour).padStart(2, "0")}:${String(preferences.minute).padStart(2, "0")}`}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(":").map(Number);
              setPreferences({ ...preferences, hour, minute });
            }}
          />
        </label>
        <label>
          Timezone
          <input value={preferences.timezone} onChange={(event) => setPreferences({ ...preferences, timezone: event.target.value })} />
        </label>
        <label>
          Digest Items
          <select value={preferences.itemCount} onChange={(event) => setPreferences({ ...preferences, itemCount: Number(event.target.value) })}>
            {[3, 4, 5].map((count) => <option key={count} value={count}>{count} repositories</option>)}
          </select>
        </label>
        <label className="settings-checkbox">
          <input type="checkbox" checked={preferences.paused} onChange={(event) => setPreferences({ ...preferences, paused: event.target.checked })} />
          Pause scheduled Digests
        </label>
        <button className="primary-action" disabled={saving} type="submit">{saving ? "Saving…" : "Save Digest settings"}</button>
      </form>
    </div>
  );
}

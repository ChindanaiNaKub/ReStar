"use client";

import { useState } from "react";

import type { FeedbackAction, RotationRepository } from "@/rotation/service";

const actions: Array<{ action: FeedbackAction; label: string; className?: string }> = [
  { action: "still_interested", label: "Still Interested", className: "feedback-primary" },
  { action: "snooze", label: "Snooze" },
  { action: "done", label: "Done" },
  { action: "forget", label: "Forget", className: "feedback-danger" },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export default function RotationView({ initialRepositories }: { initialRepositories: RotationRepository[] }) {
  const [repositories, setRepositories] = useState(initialRepositories);
  const [busyRepositoryId, setBusyRepositoryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitFeedback(repositoryId: number, action: FeedbackAction) {
    setBusyRepositoryId(repositoryId);
    setError(null);
    try {
      const response = await fetch("/api/rotation/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId, action }),
      });
      if (!response.ok) throw new Error("Feedback could not be recorded. Try again.");
      setRepositories((current) => current.filter((repository) => repository.repositoryId !== repositoryId));
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Feedback could not be recorded. Try again.");
    } finally {
      setBusyRepositoryId(null);
    }
  }

  if (repositories.length === 0) {
    return <p className="empty-state" aria-live="polite">No Eligible Repositories are waiting in Rotation.</p>;
  }

  return (
    <>
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      <div className="rotation-list">
        {repositories.map((repository) => (
          <article className="repository-card" key={repository.repositoryId}>
            <div className="repository-card-heading">
              <div>
                <p className="repository-owner">{repository.ownerLogin}</p>
                <h2>{repository.name}</h2>
              </div>
              <a href={repository.htmlUrl} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
            </div>
            <p className="repository-description">{repository.description ?? "No description provided."}</p>
            <dl className="repository-meta">
              <div><dt>Language</dt><dd>{repository.language ?? "Not specified"}</dd></div>
              <div><dt>Stars</dt><dd>{repository.starCount.toLocaleString()}</dd></div>
              <div><dt>Starred</dt><dd>{formatDate(repository.starredAt)}</dd></div>
            </dl>
            <div className="feedback-actions" aria-label={`Feedback for ${repository.fullName}`}>
              {actions.map(({ action, label, className }) => (
                <button
                  className={className}
                  disabled={busyRepositoryId === repository.repositoryId}
                  key={action}
                  onClick={() => void submitFeedback(repository.repositoryId, action)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

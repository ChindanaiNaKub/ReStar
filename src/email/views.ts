import { feedbackActionLabels, type AppliedEmailAction, type EmailActionPreview } from "./actions";

export function escapeEmailHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]!);
}

function page(content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ReStar email action</title></head><body>${content}</body></html>`;
}

export function renderEmailActionConfirmation(preview: EmailActionPreview, token: string) {
  const action = feedbackActionLabels[preview.action];
  return page(`<main><p>ReStar Digest</p><h1>Confirm ${action}</h1><p>Apply <strong>${escapeEmailHtml(action)}</strong> to <strong>${escapeEmailHtml(preview.fullName)}</strong>?</p>${preview.description ? `<p>${escapeEmailHtml(preview.description)}</p>` : ""}<form method="post"><input type="hidden" name="token" value="${escapeEmailHtml(token)}"><button type="submit">Confirm ${escapeEmailHtml(action)}</button></form></main>`);
}

export function renderEmailActionResult(applied: AppliedEmailAction) {
  const action = feedbackActionLabels[applied.action];
  return page(`<main><p>ReStar Digest</p><h1>${escapeEmailHtml(action)} recorded</h1><p><strong>${escapeEmailHtml(applied.fullName)}</strong> was updated in Rotation.</p><form method="post" action="/email/action/undo"><input type="hidden" name="token" value="${escapeEmailHtml(applied.undoToken)}"><button type="submit">Undo</button></form></main>`);
}

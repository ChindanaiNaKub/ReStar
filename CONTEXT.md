# ReStar

ReStar turns a person's accumulated GitHub Stars from passive bookmarks into an active memory system by periodically bringing forgotten repositories back to their attention.

## Language

**Starred Repository**:
A public GitHub repository that a User has starred and ReStar has imported.
_Avoid_: Bookmark, saved repo, favourite

**Resurfacing**:
Presenting an eligible Starred Repository to its User again after enough time has passed for it to be useful.
_Avoid_: Recommendation, notification, rediscovery

**Rotation**:
The set of a User's Starred Repositories that may be selected for future Resurfacing.
_Avoid_: Queue, feed, recommendation pool

**Digest**:
A scheduled collection of Resurfaced Repositories delivered to a User for review.
_Avoid_: Newsletter, campaign, notification batch

**Digest Item**:
One Resurfaced Repository within a particular Digest, including the User's response to that presentation.
_Avoid_: Recommendation, card

**Eligible Repository**:
A Starred Repository currently allowed to re-enter Rotation according to its age, state, and next eligible time.
_Avoid_: Candidate, available repo

**Still Interested**:
A Feedback Action confirming continued interest while postponing the repository's next eligibility for a longer interval.
_Avoid_: Keep, like

**Snooze**:
A Feedback Action postponing a repository's next eligibility for a shorter interval.
_Avoid_: Remind me later, defer

**Done**:
A Feedback Action stating that the User has tried or completed the repository's purpose and wants it removed from Rotation.
_Avoid_: Tried, complete, archive

**Forget**:
A Feedback Action removing a repository from Rotation and hiding it from the active view because the User no longer wants to revisit it.
_Avoid_: Delete, dismiss, unstar

**Feedback Action**:
One of Still Interested, Snooze, Done, or Forget, recorded in response to a Digest Item or active view.
_Avoid_: Reaction, status update

**Paused Digest**:
A Digest schedule that no longer sends automatically, either by User choice or after repeated Digests receive no Feedback Action.
_Avoid_: Unsubscribed user, inactive account

import { getSessionUserId } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";
import {
  getEligibleRotation,
  isFeedbackAction,
  recordFeedback,
  RotationRepositoryNotEligible,
  RotationRepositoryNotFound,
} from "@/rotation/service";

export async function GET(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json({ repositories: await getEligibleRotation(client, userId, new Date()) });
  });
}

export async function POST(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let body: { repositoryId?: unknown; action?: unknown };
    try {
      body = await request.json() as { repositoryId?: unknown; action?: unknown };
    } catch {
      return Response.json({ error: "Request body must be JSON" }, { status: 400 });
    }
    const repositoryId = Number(body.repositoryId);
    if (!Number.isSafeInteger(repositoryId) || !isFeedbackAction(body.action)) {
      return Response.json({ error: "repositoryId and a valid action are required" }, { status: 400 });
    }

    try {
      return Response.json(await recordFeedback(client, userId, repositoryId, body.action, new Date()));
    } catch (error) {
      if (error instanceof RotationRepositoryNotFound) {
        return Response.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof RotationRepositoryNotEligible) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  });
}

import { getSessionUserId } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";

export async function GET(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const rows = await client<{
      owner_login: string;
      full_name: string;
      description: string | null;
      language: string | null;
      star_count: number;
      html_url: string;
      starred_at: Date;
    }[]>`
      select repositories.owner_login, repositories.full_name, repositories.description,
        repositories.language, repositories.star_count, repositories.html_url,
        starred_repositories.starred_at
      from starred_repositories
      join repositories on repositories.id = starred_repositories.repository_id
      where starred_repositories.user_id = ${userId}
      order by starred_repositories.starred_at, repositories.id
    `;
    return Response.json({
      repositories: rows.map((row) => ({
        ownerLogin: row.owner_login,
        fullName: row.full_name,
        description: row.description,
        language: row.language,
        starCount: row.star_count,
        htmlUrl: row.html_url,
        starredAt: row.starred_at.toISOString(),
      })),
    });
  });
}

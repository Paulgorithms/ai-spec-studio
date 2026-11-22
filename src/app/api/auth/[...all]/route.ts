// Better Auth's endpoints (OAuth sign-in and callbacks, session, sign-out).
// Public by design: OAuth callbacks arrive before the user is signed in.
//
// The handler builds the auth instance on the first request, not at import,
// so `next build` doesn't need auth variables or the database.
import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/server";

export const { GET, POST } = toNextJsHandler((request) =>
  getAuth().handler(request),
);

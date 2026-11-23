// The browser authentication client, for Client Components. It talks to
// /api/auth on the page's own origin, so it needs no configuration and
// reads no environment variables: nothing here can expose a secret.
//
// Server code reads sessions through getAuth() in ./server instead.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

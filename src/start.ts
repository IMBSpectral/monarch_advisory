import { createStart, createMiddleware, createCsrfMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

/**
 * CSRF protection for server functions.
 *
 * Server functions are same-origin RPC endpoints reached by POST, and the
 * session cookie is sent automatically by the browser. Without this, any site
 * a signed-in user visits could POST to them and act as that user — posting
 * invoices, recording payments, changing roles.
 *
 * The session cookie is already `SameSite=Lax`, which blocks the common case,
 * but Lax is a *browser-side* mitigation with real gaps: it permits top-level
 * GET navigations, and its enforcement varies across browser versions.
 * Origin verification on the server is the control that doesn't depend on the
 * client behaving well. Defence in depth — both, not either.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  // CSRF first: reject forged cross-site requests before any handler runs.
  requestMiddleware: [csrfMiddleware, errorMiddleware],
}));

import { useCallback, useEffect, useState } from "react";
import type { Principal } from "@graph-warden/core";
import { api, HttpError } from "./api.js";
import { applyDelta, empty, type Store } from "./graph.js";
import { useRoute } from "./route.js";
import { Login } from "./views/Login.js";
import { Page } from "./views/Page.js";
import { Search } from "./views/Search.js";
import { Shell } from "./views/Shell.js";

type Session =
  | { readonly state: "loading" }
  | { readonly state: "signed-out"; readonly login: "demo" | "oidc"; readonly error?: string }
  | { readonly state: "signed-in"; readonly principal: Principal };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [store, setStore] = useState<Store>(empty);
  const [error, setError] = useState<string>();
  const route = useRoute();

  const signedOut = useCallback(async (message?: string) => {
    const { login } = await api.config();
    setStore(empty);
    setSession({ state: "signed-out", login, ...(message === undefined ? {} : { error: message }) });
  }, []);

  // The whole readable graph, then only what changed. Another principal, or other groups, is another
  // reader: the copy starts over, as in the CLI cache.
  const pull = useCallback(
    async (from: Store, reader?: Principal): Promise<void> => {
      try {
        const { principal, delta } = await api.pull(from.cursor);
        const same = reader !== undefined && reader.user === principal.user && reader.teams.join() === principal.teams.join();
        if (from.cursor !== 0 && !same) return pull(empty);
        setSession({ state: "signed-in", principal });
        // A full pull replaces the copy; a later one applies only if nothing was applied meanwhile.
        setStore((current) => (from.cursor === 0 ? applyDelta(empty, delta) : current.cursor === from.cursor ? applyDelta(current, delta) : current));
        setError(undefined);
      } catch (cause) {
        if (cause instanceof HttpError && cause.status === 401) return signedOut();
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [signedOut],
  );

  useEffect(() => {
    void pull(empty);
  }, [pull]);

  if (session.state === "loading") return <p className="loading">Loading…</p>;
  if (session.state === "signed-out") {
    return (
      <Login
        login={session.login}
        {...(session.error === undefined ? {} : { error: session.error })}
        onSignedIn={() => void pull(empty)}
      />
    );
  }

  const signOut = async () => {
    await api.signOut();
    await signedOut();
  };

  return (
    <Shell principal={session.principal} store={store} error={error} onRefresh={() => void pull(store, session.principal)} onSignOut={() => void signOut()}>
      {route.view === "node" ? (
        <Page store={store} id={route.id} />
      ) : route.view === "search" ? (
        <Search store={store} query={route.query} />
      ) : (
        <Search store={store} query="" />
      )}
    </Shell>
  );
}

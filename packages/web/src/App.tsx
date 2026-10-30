import { useCallback, useEffect, useRef, useState } from "react";
import type { Delta, Principal } from "@graph-warden/core";
import { api, HttpError } from "./api.js";
import { applyDelta, empty, type Store } from "./graph.js";
import { useRoute } from "./route.js";
import { Ask } from "./views/Ask.js";
import { Editor } from "./views/Editor.js";
import { GraphView } from "./views/GraphView.js";
import { Login } from "./views/Login.js";
import { Page } from "./views/Page.js";
import { Search } from "./views/Search.js";
import { Shell } from "./views/Shell.js";

type Session =
  | { readonly state: "loading" }
  | { readonly state: "signed-out"; readonly login: "demo" | "oidc"; readonly error?: string }
  | { readonly state: "signed-in"; readonly principal: Principal };

const sameReader = (a: Principal, b: Principal) => a.user === b.user && a.teams.join() === b.teams.join();

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [store, setStore] = useState<Store>(empty);
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(false);
  const route = useRoute();
  // The reader the copy was pulled for, read by the stream without restarting it.
  const reader = useRef<Principal>(undefined);

  const signedOut = useCallback(async (message?: string) => {
    const { login } = await api.config();
    reader.current = undefined;
    setStore(empty);
    setSession({ state: "signed-out", login, ...(message === undefined ? {} : { error: message }) });
  }, []);

  const receive = (principal: Principal, delta: Delta, full: boolean) => {
    reader.current = principal;
    setSession((current) => (current.state === "signed-in" && sameReader(current.principal, principal) ? current : { state: "signed-in", principal }));
    // A delta older than the copy (a refresh overtaken by the stream) would take it back in time.
    setStore((current) => (full ? applyDelta(empty, delta) : delta.cursor >= current.cursor ? applyDelta(current, delta) : current));
  };

  // The whole readable graph first, then only what changed. Another principal, or other groups, is
  // another reader: the copy starts over, as in the CLI cache.
  const pull = useCallback(
    async (after: number): Promise<void> => {
      try {
        const { principal, delta } = await api.pull(after);
        if (after !== 0 && (reader.current === undefined || !sameReader(reader.current, principal))) return pull(0);
        receive(principal, delta, after === 0);
        setError(undefined);
      } catch (cause) {
        if (cause instanceof HttpError && cause.status === 401) return signedOut();
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [signedOut],
  );

  useEffect(() => {
    void pull(0);
  }, [pull]);

  // Changes as they happen (proposal 0012). The browser reconnects by itself, from the last event
  // id; a stream refused for want of a session ends in a pull, which signs out.
  const signedIn = session.state === "signed-in";
  const cursor = useRef(0);
  cursor.current = store.cursor;
  useEffect(() => {
    if (!signedIn || typeof EventSource === "undefined") return;
    const stream = new EventSource(`/v1/stream?after=${cursor.current}`);
    stream.addEventListener("open", () => setLive(true));
    stream.addEventListener("delta", (event) => {
      const { principal, delta } = JSON.parse((event as MessageEvent<string>).data) as { principal: Principal; delta: Delta };
      if (reader.current !== undefined && !sameReader(reader.current, principal)) void pull(0);
      else receive(principal, delta, false);
    });
    stream.addEventListener("signed-out", () => {
      stream.close();
      void signedOut();
    });
    stream.addEventListener("error", () => {
      setLive(false);
      if (stream.readyState === EventSource.CLOSED) void pull(0);
    });
    return () => {
      stream.close();
      setLive(false);
    };
  }, [signedIn, pull, signedOut]);

  if (session.state === "loading") return <p className="loading">Loading…</p>;
  if (session.state === "signed-out") {
    return (
      <Login login={session.login} {...(session.error === undefined ? {} : { error: session.error })} onSignedIn={() => void pull(0)} />
    );
  }

  const signOut = async () => {
    await api.signOut();
    await signedOut();
  };

  return (
    <Shell
      principal={session.principal}
      store={store}
      error={error}
      live={live}
      onRefresh={() => void pull(store.cursor)}
      onSignOut={() => void signOut()}
    >
      {route.view === "node" ? (
        <Page store={store} id={route.id} />
      ) : route.view === "edit" ? (
        <Editor key={route.id ?? ""} principal={session.principal} {...(route.id === undefined ? {} : { id: route.id })} />
      ) : route.view === "ask" ? (
        <Ask store={store} principal={session.principal} {...(route.from === undefined ? {} : { from: route.from })} />
      ) : route.view === "graph" ? (
        <GraphView store={store} {...(route.id === undefined ? {} : { focus: route.id })} />
      ) : (
        <Search store={store} query={route.view === "search" ? route.query : ""} />
      )}
    </Shell>
  );
}

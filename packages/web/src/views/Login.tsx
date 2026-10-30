import { useState, type FormEvent } from "react";
import { api } from "../api.js";

export function Login(props: { login: "demo" | "oidc"; error?: string; onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState(props.error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.signInDemo(token);
      props.onSignedIn();
    } catch {
      setError("This token is not known.");
    }
  };

  return (
    <main className="login">
      <h1>Graph-Warden</h1>
      <p>The knowledge your teams may read, and where it comes from.</p>
      {props.login === "oidc" ? (
        <a className="button" href="/auth/login">
          Sign in
        </a>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Demo token
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoFocus />
          </label>
          <button type="submit" disabled={token === ""}>
            Sign in
          </button>
          <p className="hint">Demo mode: anyone holding a token is that user.</p>
        </form>
      )}
      {error === undefined ? null : <p className="error">{error}</p>}
    </main>
  );
}

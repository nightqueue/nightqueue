import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../lib/actions";
import { postJson } from "../lib/api";
import { showToast } from "../lib/toast";
import { trackerLabel } from "../lib/tracker";
import { Modal } from "./Modal";
import { Button, FIELD_CLASS } from "./ui";

interface ConnectTrackerModalProps {
  provider: string;
  onClose: () => void;
  onConnected: () => void;
}

interface ConnectAnswer {
  viewer: string | null;
}

// The success toast of a connect: the viewer Linear named, or the tracker alone when it named none.
function connectedText(provider: string, viewer: unknown): string {
  return typeof viewer === "string" && viewer ? `Conectado como ${viewer}` : `Conectado ao ${trackerLabel(provider)}`;
}

// The connect dialog of a tracker: an API key the server tests before saving; a refusal stays inside the dialog.
export function ConnectTrackerModal({ provider, onClose, onConnected }: ConnectTrackerModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () => postJson<ConnectAnswer>(`/api/connections/${provider}`, { api_key: apiKey }),
    onSuccess: (answer) => {
      showToast(connectedText(provider, answer?.viewer), "success");
      onClose();
      onConnected();
    },
    onError: (err) => setError(errorText(err)),
  });
  const blank = apiKey.trim() === "";
  const submit = () => {
    if (blank || connect.isPending) return;
    setError(null);
    connect.mutate();
  };
  return (
    <Modal
      title={`Conectar ${trackerLabel(provider)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={blank || connect.isPending} onClick={submit}>
            {connect.isPending ? "Conectando…" : "Conectar"}
          </Button>
        </>
      }
    >
      <label htmlFor="tracker-api-key" className="text-sm text-muted">
        API key
      </label>
      <input
        id="tracker-api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        className={`${FIELD_CLASS} min-h-9 w-full px-2.5`}
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
      />
      {error && <p className="m-0 text-sm text-red">{error}</p>}
    </Modal>
  );
}

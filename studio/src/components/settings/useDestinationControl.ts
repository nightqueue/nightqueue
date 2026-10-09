import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../../lib/actions";
import { NO_DESTINATION, refusalOf, type Refusal } from "../../lib/integrations";
import { showToast } from "../../lib/toast";
import type { ProjectDestination } from "../../lib/types";
import { allowOrg, setDestination, useRefreshIntegrations } from "../../lib/useIntegrations";

export interface DestinationControl {
  value: string;
  refusal: Refusal | null;
  pending: boolean;
  pick: (value: string) => void;
  unlink: () => void;
  allowAndApply: () => void;
  cancel: () => void;
}

// The destination select of one project: applies a pick at once, keeps an org refusal to show, and allows-then-applies on demand.
export function useDestinationControl(project: ProjectDestination): DestinationControl {
  const refresh = useRefreshIntegrations();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const apply = useMutation({
    mutationFn: (connectionId: string | null) => setDestination(project.id, connectionId),
    onSuccess: () => {
      setRefusal(null);
      refresh();
    },
    onError: (err) => {
      const refused = refusalOf(err);
      if (refused) setRefusal(refused);
      else showToast(errorText(err), "error");
    },
  });
  const allow = useMutation({
    mutationFn: async (target: Refusal) => {
      await allowOrg(target.connectionId, target.org);
      await setDestination(project.id, target.connectionId);
    },
    onSuccess: (_answer, target) => {
      setRefusal(null);
      showToast(`${target.connectionId} allowed for ${target.org} · ${project.name} linked`, "success");
    },
    onError: (err) => showToast(errorText(err), "error"),
    onSettled: refresh,
  });
  const value = project.destination ?? NO_DESTINATION;
  return {
    value,
    refusal,
    pending: apply.isPending || allow.isPending,
    pick: (next) => {
      if (next === value) return;
      apply.mutate(next === NO_DESTINATION ? null : next);
    },
    unlink: () => apply.mutate(null),
    allowAndApply: () => refusal && allow.mutate(refusal),
    cancel: () => setRefusal(null),
  };
}

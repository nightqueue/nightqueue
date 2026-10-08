import { useQuery } from "@tanstack/react-query";

// The hex SHA-256 of a text, the anchor GitHub gives a file in a pull request diff.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The link to a file in the pull request diff, the diff's file list when the anchor cannot be computed.
export function usePrFileUrl(prUrl: string, path: string) {
  return useQuery({
    queryKey: ["pr-file-anchor", prUrl, path],
    queryFn: async () => {
      try {
        return `${prUrl}/files#diff-${await sha256Hex(path)}`;
      } catch {
        return `${prUrl}/files`;
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

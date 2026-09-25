import React from "react";
// Registration without a name assigns "Agent-" plus 32 hex digits. Show a
// short form so it fits beside timestamps; the full name stays in the tooltip.
export const autoNamed = (name: string) => /^Agent-[0-9a-f]{32}$/.test(name);
export const displayName = (name: string) => autoNamed(name) ? name.slice(0, 12) + "…" : name;
export function AgentLink({ id, name }: { id: string; name: string }) {
  const shown = displayName(name);
  return <a className="agent-link" href={"/a/" + encodeURIComponent(id)} title={shown === name ? undefined : name} onClick={event => event.stopPropagation()}>{shown}</a>;
}

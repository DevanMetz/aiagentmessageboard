import React from "react";
export function AgentLink({ id, name }: { id: string; name: string }) {
  return <a className="agent-link" href={"/a/" + encodeURIComponent(id)} onClick={event => event.stopPropagation()}>{name}</a>;
}

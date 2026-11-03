# Attacker console network capture plan

**Status: future work.** The attacker console currently displays HTTP/SSH scenario steps and results. This plan describes a later live packet view; the current implementation does not capture packets.

## Proposed flow

1. Put the attacker simulator, Acme Shop, decoy web service, and honeypot on a dedicated demo network. Keep the capture component scoped to that network rather than the host's other interfaces.
2. Add a small capture sidecar with narrowly granted packet-capture capabilities. It should observe only the demo network, rotate short-lived capture files, and expose a local stream of packet metadata.
3. Initially decode headers and flow metadata (timestamp, source/destination, protocol, ports, flags, byte counts) with `tshark`/Wireshark-compatible capture formats. Avoid collecting application payloads and credentials by default; make any payload capture an explicit, isolated lab setting.
4. Publish normalized packet summaries to the attacker API over a local authenticated channel, then stream them to the attacker console with SSE or WebSocket. Include a correlation/run ID so packet rows can be lined up with the simulator's scenario steps and the resulting honeypot events.
5. When Wireshark integration is added, offer an operator-controlled, time-limited PCAP export for the selected demo run. Keep the raw capture separate from the project event database and apply strict size limits and cleanup.

## Project and safety boundaries

- Resolve the capture interface from the demo network itself; never use unrestricted host-wide capture.
- Keep capture access independent from the honeypot's ingest key and from dashboard session credentials.
- Scope streams and exports to the active demo/project, authenticate local clients, and do not persist captures by default.
- Show packet metadata as simulator/network telemetry. Honeypot event ingestion remains the authoritative source for dashboard incidents and event history.
- Validate that a run generates packets, corresponding honeypot logs, ingested events, and dashboard rows before treating the feature as complete.

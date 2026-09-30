# Legacy scratch workspace

The saved `runLocation: sandbox` value selects a scratch directory for compatibility.
It does not provide OS isolation. Commands run on the host with the normal environment.
The former regex command firewall, synthetic environment, and sandbox tool restrictions
have been removed. Explicit workspace and tool preferences are handled by the agent runtime.

Multi-Tasking OS Demo Site — Iteration 2/4

Files:
- index.html
- styles.css
- app.js

How to run:
- Open index.html in your browser (no server needed).

What's implemented (requested):
1) Workload is editable (process table with arrival, priority, CPU/IO bursts)
2) Play/pause animation + step + run-to-end
3) Explicit cooperative vs preemptive switching style
4) Scheduling policies (FCFS, SJF, Priority, RR) + dropdown policy comparison (less cramped)
5) Animation of how processes move between states (New → Ready → Running → Blocked → Done)

Notes:
- Burst strings use: CPU<ms>, IO<ms>, AT<ms> (wait until absolute time), and (optional) YIELD.
- Priorities: larger number means higher priority.
- This is an educational simulator (not a full OS kernel).

Iteration 2 changes:
- Built-in workload matches the PDF example: PA, PB, PC (PC uses `CPU5 AT60 CPU5`).
- Corrected I/O/wait timing so the generated schedules match the report tables.
- Multiprocessing preset updated to priority + preemptive + 2 cores to mirror the report's multiprocessing schedule.

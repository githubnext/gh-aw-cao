----------------------- MODULE LocalWebhookGateway -----------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Deliveries, Subscribers, Workers, Capacity, MaxClock, MaxFence, MaxVersion
Jobs == Deliveries \X Subscribers
Terminal == {"succeeded", "ambiguous", "cancelled", "expired", "failed"}
Pending == {"ready", "claimed", "dispatching"}
Empty == [state |-> "absent", owner |-> "none", fence |-> 0, version |-> 0,
          lease |-> 0, revision |-> 0, beginRevision |-> 0, reserved |-> FALSE,
          accepted |-> FALSE, unknown |-> FALSE, renewed |-> FALSE]
NoTicket == [fence |-> 0, version |-> 0]

VARIABLES jobs, receipts, tickets, alive, now, revision, enabled,
          polling, window, checkpoint, pollRevision, remoteWrites
vars == <<jobs, receipts, tickets, alive, now, revision, enabled,
          polling, window, checkpoint, pollRevision, remoteWrites>>
Stored == {j \in Jobs : jobs[j].state # "absent"}
Used == Cardinality(Stored) + Cardinality(receipts)
Other == <<alive, now, revision, enabled, polling, window, checkpoint,
           pollRevision, remoteWrites>>
Fenced(j,w) ==
    /\ alive[w] /\ jobs[j].owner = w /\ now < jobs[j].lease
    /\ tickets[w][j] = [fence |-> jobs[j].fence, version |-> jobs[j].version]
    /\ jobs[j].version < MaxVersion
Ticket(j) == [fence |-> jobs'[j].fence, version |-> jobs'[j].version]

Init ==
    /\ jobs = [j \in Jobs |-> Empty] /\ receipts = {}
    /\ tickets = [w \in Workers |-> [j \in Jobs |-> NoTicket]]
    /\ alive = [w \in Workers |-> TRUE]
    /\ now = 0 /\ revision = 1 /\ enabled = TRUE
    /\ polling = FALSE /\ window = {} /\ checkpoint = {} /\ pollRevision = 0
    /\ remoteWrites = 0

\* A finite feed snapshot stands for bounded GET pagination; all events match.
Poll ==
    /\ ~polling /\ \E w \in Workers : alive[w]
    /\ polling' = TRUE /\ window' \in SUBSET Deliveries
    /\ pollRevision' = revision
    /\ UNCHANGED <<jobs, receipts, tickets, alive, now, revision, enabled,
                   checkpoint, remoteWrites>>

\* All fanout jobs AND the retained receipt commit in one transaction.
Admit(d) ==
    /\ polling /\ d \in window /\ d \notin receipts
    /\ enabled /\ pollRevision = revision
    /\ Used + Cardinality(Subscribers) + 1 <= Capacity
    /\ jobs' = [j \in Jobs |-> IF j[1] = d
           THEN [Empty EXCEPT !.state = "ready", !.revision = revision,
                             !.version = 1] ELSE jobs[j]]
    /\ receipts' = receipts \cup {d}
    /\ UNCHANGED <<tickets, Other>>
Replay(d) ==
    /\ polling /\ d \in window /\ d \in receipts /\ UNCHANGED vars
Checkpoint ==
    /\ polling /\ window \subseteq receipts
    /\ checkpoint' = window /\ polling' = FALSE
    /\ window' = {} /\ pollRevision' = 0
    /\ UNCHANGED <<jobs, receipts, tickets, alive, now, revision, enabled, remoteWrites>>

Claim(j,w) ==
    /\ jobs[j].state = "ready" /\ enabled /\ jobs[j].revision = revision
    /\ alive[w] /\ now < MaxClock
    /\ jobs[j].fence < MaxFence /\ jobs[j].version < MaxVersion
    /\ jobs' = [jobs EXCEPT ![j].state = "claimed", ![j].owner = w,
          ![j].fence = @ + 1, ![j].version = @ + 1, ![j].lease = now + 1,
          ![j].renewed = FALSE]
    /\ tickets' = [tickets EXCEPT ![w][j] = Ticket(j)]
    /\ UNCHANGED <<receipts, Other>>
Renew(j,w) ==
    /\ jobs[j].state = "claimed" /\ Fenced(j,w) /\ ~jobs[j].renewed
    /\ jobs' = [jobs EXCEPT ![j].version = @ + 1, ![j].renewed = TRUE]
    /\ tickets' = [tickets EXCEPT ![w][j] = Ticket(j)]
    /\ UNCHANGED <<receipts, Other>>
Begin(j,w) ==
    /\ jobs[j].state = "claimed" /\ Fenced(j,w)
    /\ enabled /\ jobs[j].revision = revision
    /\ jobs' = [jobs EXCEPT ![j].state = "dispatching",
          ![j].version = @ + 1, ![j].reserved = TRUE, ![j].beginRevision = revision]
    /\ tickets' = [tickets EXCEPT ![w][j] = Ticket(j)]
    /\ UNCHANGED <<receipts, Other>>
Finish(j,w,result) ==
    /\ jobs[j].state = "dispatching" /\ Fenced(j,w)
    /\ result \in {"accept", "not-sent", "unknown"}
    /\ jobs' = [jobs EXCEPT ![j].state =
          CASE result = "accept" -> "succeeded"
            [] result = "unknown" -> "ambiguous"
            [] OTHER -> IF enabled /\ jobs[j].revision = revision
                        THEN "ready" ELSE "cancelled",
          ![j].accepted = (result = "accept"), ![j].unknown = (result = "unknown"),
          ![j].owner = "none", ![j].version = @ + 1]
    /\ UNCHANGED <<receipts, tickets, Other>>
Recover(j) ==
    /\ jobs[j].state \in {"claimed", "dispatching"}
    /\ now >= jobs[j].lease
    /\ jobs[j].version < MaxVersion /\ jobs[j].fence < MaxFence
    /\ jobs' = [jobs EXCEPT ![j].state =
          IF jobs[j].state = "dispatching" THEN "ambiguous"
          ELSE IF now = MaxClock THEN "expired" ELSE "ready",
          ![j].unknown = (jobs[j].state = "dispatching"),
          ![j].owner = "none", ![j].version = @ + 1, ![j].fence = @ + 1]
    /\ UNCHANGED <<receipts, tickets, Other>>
Expire(j) ==
    /\ jobs[j].state = "ready" /\ now = MaxClock
    /\ jobs' = [jobs EXCEPT ![j].state = "expired"]
    /\ UNCHANGED <<receipts, tickets, Other>>
Revise(on) ==
    /\ revision = 1 /\ on \in BOOLEAN
    /\ \A j \in Jobs : jobs[j].state \in {"ready","claimed"} =>
          jobs[j].version < MaxVersion /\ jobs[j].fence < MaxFence
    /\ revision' = 2 /\ enabled' = on
    /\ jobs' = [j \in Jobs |-> IF jobs[j].state \in {"ready","claimed"}
         THEN [jobs[j] EXCEPT !.state = "cancelled", !.owner = "none",
                 !.fence = @ + 1, !.version = @ + 1] ELSE jobs[j]]
    /\ UNCHANGED <<receipts, tickets, alive, now, polling, window, checkpoint,
                   pollRevision, remoteWrites>>
Tick ==
    /\ now < MaxClock /\ now' = now + 1
    /\ UNCHANGED <<jobs, receipts, tickets, alive, revision, enabled, polling,
                   window, checkpoint, pollRevision, remoteWrites>>
\* Durable state survives. An ETag/checkpoint is deliberately volatile.
Crash(w) ==
    /\ alive[w] /\ alive' = [alive EXCEPT ![w] = FALSE]
    /\ polling' = FALSE /\ window' = {} /\ checkpoint' = {} /\ pollRevision' = 0
    /\ UNCHANGED <<jobs, receipts, tickets, now, revision, enabled, remoteWrites>>
Restart(w) ==
    /\ ~alive[w] /\ alive' = [alive EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<jobs, receipts, tickets, now, revision, enabled, polling,
                   window, checkpoint, pollRevision, remoteWrites>>

Next ==
    \/ Poll \/ Checkpoint \/ Tick \/ \E on \in BOOLEAN : Revise(on)
    \/ \E d \in Deliveries : Admit(d) \/ Replay(d)
    \/ \E j \in Jobs : Recover(j) \/ Expire(j)
    \/ \E j \in Jobs,w \in Workers : Claim(j,w) \/ Renew(j,w) \/ Begin(j,w)
          \/ \E result \in {"accept","not-sent","unknown"} : Finish(j,w,result)
    \/ \E w \in Workers : Crash(w) \/ Restart(w)
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ jobs \in [Jobs -> [state : Pending \cup Terminal \cup {"absent"},
        owner : Workers \cup {"none"}, fence : 0..MaxFence, version : 0..MaxVersion,
        lease : 0..MaxClock, revision : 0..2, beginRevision : 0..2, reserved : BOOLEAN,
        accepted : BOOLEAN, unknown : BOOLEAN, renewed : BOOLEAN]]
    /\ receipts \subseteq Deliveries /\ window \subseteq Deliveries
    /\ checkpoint \subseteq Deliveries /\ now \in 0..MaxClock
    /\ revision \in 1..2 /\ enabled \in BOOLEAN /\ polling \in BOOLEAN
    /\ pollRevision \in 0..2 /\ remoteWrites \in Nat
    /\ alive \in [Workers -> BOOLEAN]
    /\ tickets \in [Workers -> [Jobs -> [fence : 0..MaxFence,version : 0..MaxVersion]]]
Bounded == Used <= Capacity
NoSkippedProgress == checkpoint \subseteq receipts
NoRemoteWrites == remoteWrites = 0
DispatchWasReserved == \A j \in Jobs : jobs[j].state = "dispatching" => jobs[j].reserved
NoStaleRevisionReservation ==
    \A j \in Jobs : jobs[j].reserved => jobs[j].beginRevision = jobs[j].revision
SuccessRequiresSimulation ==
    \A j \in Jobs : jobs[j].state = "succeeded" => jobs[j].accepted /\ remoteWrites = 0
NoUnknownReplay == \A j \in Jobs : jobs[j].unknown => jobs[j].state = "ambiguous"
TerminalStable ==
    [][\A j \in Jobs : jobs[j].state \in Terminal => jobs'[j].state = jobs[j].state]_vars
FenceMonotonic == [][\A j \in Jobs : jobs'[j].fence >= jobs[j].fence]_vars
=============================================================================

//! The hub owns delayed KILL targets even after an actor exits or is forgotten.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::Id;
use tokio::time::Instant;

use crate::acp::Group;
use crate::lock;
use crate::procfs::SessionMembers;

enum Target {
    Session(SessionMembers),
    Group(Group),
}

impl Target {
    fn kill(self) {
        match self {
            Self::Session(members) => members.kill(),
            Self::Group(group) => drop(group), // KILL before releasing/reaping the leader.
        }
    }
}

pub(crate) struct Escalations {
    pending: Mutex<Option<HashMap<Id, Target>>>,
    #[cfg(test)]
    kill_gate: Option<Arc<tokio::sync::Notify>>,
}

impl Default for Escalations {
    fn default() -> Self {
        Self {
            pending: Mutex::new(Some(HashMap::new())),
            #[cfg(test)]
            kill_gate: None,
        }
    }
}

impl Escalations {
    pub(crate) fn arm(self: &Arc<Self>, members: SessionMembers, grace: Duration) {
        self.arm_target(Target::Session(members), grace);
    }

    pub(crate) fn arm_group(self: &Arc<Self>, group: Group, grace: Duration) {
        self.arm_target(Target::Group(group), grace);
    }

    fn arm_target(self: &Arc<Self>, target: Target, grace: Duration) {
        let mut pending = lock(&self.pending);
        let Some(targets) = pending.as_mut() else {
            return target.kill();
        };
        let owner = Arc::downgrade(self);
        let deadline = Instant::now() + grace;
        #[cfg(test)]
        let gate = self.kill_gate.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            #[cfg(test)]
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let Some(owner) = owner.upgrade() else { return };
            let mut pending = lock(&owner.pending);
            if let Some(target) = pending.as_mut().and_then(|s| s.remove(&tokio::task::id())) {
                target.kill();
            }
        });
        targets.insert(timer.id(), target);
    }

    pub(crate) fn finish(&self) {
        // Serialize delivery itself with the timers, not just removal from the map.
        let mut pending = lock(&self.pending);
        if let Some(targets) = pending.take() {
            for target in targets.into_values() {
                target.kill();
            }
        }
    }

    /// Hold a single escalation until the test has observed TERM.
    /// Install before starting the actor, including when the actor may unwind.
    #[cfg(test)]
    pub(crate) fn gated_for_test() -> (Self, Arc<tokio::sync::Notify>) {
        let gate = Arc::new(tokio::sync::Notify::new());
        let mut escalations = Self::default();
        escalations.kill_gate = Some(gate.clone());
        (escalations, gate)
    }

    /// Move the captured targets out of the timers' reach without killing them yet.
    #[cfg(test)]
    pub(crate) fn take_pending_for_test(&self) -> Self {
        Self {
            pending: Mutex::new(lock(&self.pending).take()),
            kill_gate: None,
        }
    }
}

impl Drop for Escalations {
    fn drop(&mut self) {
        self.finish();
    }
}

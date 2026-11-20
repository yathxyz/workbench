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

pub(crate) struct Escalations(Mutex<Option<HashMap<Id, Target>>>);

impl Default for Escalations {
    fn default() -> Self {
        Self(Mutex::new(Some(HashMap::new())))
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
        let mut pending = lock(&self.0);
        let Some(targets) = pending.as_mut() else {
            return target.kill();
        };
        let owner = Arc::downgrade(self);
        let deadline = Instant::now() + grace;
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let Some(owner) = owner.upgrade() else { return };
            let mut pending = lock(&owner.0);
            if let Some(target) = pending.as_mut().and_then(|s| s.remove(&tokio::task::id())) {
                target.kill();
            }
        });
        targets.insert(timer.id(), target);
    }

    pub(crate) fn finish(&self) {
        // Serialize delivery itself with the timers, not just removal from the map.
        let mut pending = lock(&self.0);
        if let Some(targets) = pending.take() {
            for target in targets.into_values() {
                target.kill();
            }
        }
    }

    /// Move the captured targets out of the timers' reach without killing them yet.
    #[cfg(test)]
    pub(crate) fn take_pending_for_test(&self) -> Self {
        Self(Mutex::new(lock(&self.0).take()))
    }
}

impl Drop for Escalations {
    fn drop(&mut self) {
        self.finish();
    }
}

use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::str::FromStr;

pub const MAX_TURNS_MIN: u32 = 1;
pub const MAX_TURNS_MAX: u32 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct MaxTurns(u32);

impl MaxTurns {
    pub const fn get(self) -> u32 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaxTurnsError;

impl fmt::Display for MaxTurnsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "maximum turns must be an integer between {MAX_TURNS_MIN} and {MAX_TURNS_MAX}"
        )
    }
}

impl std::error::Error for MaxTurnsError {}

impl TryFrom<u64> for MaxTurns {
    type Error = MaxTurnsError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        let value = u32::try_from(value).map_err(|_| MaxTurnsError)?;
        if !(MAX_TURNS_MIN..=MAX_TURNS_MAX).contains(&value) {
            return Err(MaxTurnsError);
        }
        Ok(Self(value))
    }
}

impl FromStr for MaxTurns {
    type Err = MaxTurnsError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        value
            .parse::<u64>()
            .map_err(|_| MaxTurnsError)
            .and_then(Self::try_from)
    }
}

impl<'de> Deserialize<'de> for MaxTurns {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::try_from(value).map_err(serde::de::Error::custom)
    }
}

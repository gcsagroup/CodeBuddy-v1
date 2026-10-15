use super::ProtocolError;
use serde::{Deserialize, Deserializer, Serialize};

pub const CURRENT_PROTOCOL_VERSION: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ProtocolVersion(u16);

impl ProtocolVersion {
    pub const V1: Self = Self(1);
    pub const V2: Self = Self(2);
    pub const CURRENT: Self = Self(CURRENT_PROTOCOL_VERSION);

    pub const fn get(self) -> u16 {
        self.0
    }
}

impl TryFrom<u16> for ProtocolVersion {
    type Error = ProtocolError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::V1),
            2 => Ok(Self::V2),
            _ => Err(ProtocolError::UnsupportedVersion(value)),
        }
    }
}

impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u16::deserialize(deserializer)?;
        Self::try_from(value).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_numeric_and_reject_unknown_values() {
        assert_eq!(serde_json::to_string(&ProtocolVersion::V1).unwrap(), "1");
        assert_eq!(serde_json::to_string(&ProtocolVersion::V2).unwrap(), "2");
        assert_eq!(
            serde_json::from_str::<ProtocolVersion>("1").unwrap(),
            ProtocolVersion::V1
        );
        assert_eq!(
            serde_json::from_str::<ProtocolVersion>("2").unwrap(),
            ProtocolVersion::V2
        );
        assert!(serde_json::from_str::<ProtocolVersion>("3").is_err());
    }
}

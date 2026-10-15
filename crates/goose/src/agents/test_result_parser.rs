#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TestResultSummary {
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
}

impl TestResultSummary {
    pub(crate) fn parse(output: &str) -> Option<Self> {
        Self::parse_cargo(output).or_else(|| Self::parse_pytest(output))
    }

    fn parse_cargo(output: &str) -> Option<Self> {
        let line = output
            .lines()
            .rev()
            .find(|line| line.contains("test result:"))?;
        let passed = extract_count(line, "passed")?;
        let failed = extract_count(line, "failed").unwrap_or(0);
        let skipped = extract_count(line, "ignored").unwrap_or(0);
        Some(Self {
            passed,
            failed,
            skipped,
        })
    }

    fn parse_pytest(output: &str) -> Option<Self> {
        let line = output.lines().rev().find(|line| {
            line.contains('=')
                && (line.contains("passed") || line.contains("failed") || line.contains("skipped"))
        })?;
        let passed = extract_count(line, "passed").unwrap_or(0);
        let failed = extract_count(line, "failed").unwrap_or(0);
        let skipped = extract_count(line, "skipped").unwrap_or(0);
        Some(Self {
            passed,
            failed,
            skipped,
        })
    }
}

fn extract_count(line: &str, keyword: &str) -> Option<u32> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    for (index, part) in parts.iter().enumerate() {
        if index == 0 {
            continue;
        }
        let token = part.trim_end_matches([',', ';', '.']);
        if token == keyword {
            return parts[index - 1].parse::<u32>().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::TestResultSummary;

    #[test]
    fn parses_cargo_test_success() {
        let output = "running 10 tests\ntest foo ... ok\ntest result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 10);
        assert_eq!(summary.failed, 0);
        assert_eq!(summary.skipped, 0);
    }

    #[test]
    fn parses_cargo_test_failure() {
        let output =
            "test result: FAILED. 5 passed; 2 failed; 0 ignored; 0 measured; 3 filtered out";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 5);
        assert_eq!(summary.failed, 2);
        assert_eq!(summary.skipped, 0);
    }

    #[test]
    fn parses_cargo_test_with_ignored() {
        let output = "test result: ok. 8 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 8);
        assert_eq!(summary.failed, 0);
        assert_eq!(summary.skipped, 3);
    }

    #[test]
    fn parses_pytest_all_passed() {
        let output = "==== 10 passed in 3.45s ====\n";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 10);
        assert_eq!(summary.failed, 0);
        assert_eq!(summary.skipped, 0);
    }

    #[test]
    fn parses_pytest_mixed_results() {
        let output = "======== 5 passed, 2 failed, 1 skipped in 3.45s ========";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 5);
        assert_eq!(summary.failed, 2);
        assert_eq!(summary.skipped, 1);
    }

    #[test]
    fn parses_pytest_failed_only() {
        let output = "==== 2 failed in 1.2s ====";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 0);
        assert_eq!(summary.failed, 2);
        assert_eq!(summary.skipped, 0);
    }

    #[test]
    fn returns_none_for_non_test_output() {
        let output = "Compiling foo v0.1.0\nFinished dev profile";
        assert!(TestResultSummary::parse(output).is_none());
    }

    #[test]
    fn returns_none_for_empty_output() {
        assert!(TestResultSummary::parse("").is_none());
    }

    #[test]
    fn handles_multiline_cargo_output() {
        let output = "running 3 tests\ntest a ... ok\ntest b ... ok\ntest c ... ok\n\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n\nfinished";
        let summary = TestResultSummary::parse(output).unwrap();
        assert_eq!(summary.passed, 3);
    }
}

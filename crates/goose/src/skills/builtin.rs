use include_dir::{include_dir, Dir};

static BUILTIN_SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/skills/builtins");

pub fn get_all() -> Vec<&'static str> {
    BUILTIN_SKILLS_DIR
        .files()
        .filter(|f| f.path().extension().is_some_and(|ext| ext == "md"))
        .filter_map(|f| f.contents_utf8())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_placeholder_is_not_loaded_as_a_skill() {
        assert!(BUILTIN_SKILLS_DIR.get_file(".gitkeep").is_some());
        let skill_files = BUILTIN_SKILLS_DIR
            .files()
            .filter(|file| file.path().extension().is_some_and(|ext| ext == "md"))
            .filter(|file| file.contents_utf8().is_some())
            .count();
        assert_eq!(get_all().len(), skill_files);
    }
}

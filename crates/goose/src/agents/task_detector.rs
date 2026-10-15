pub struct TaskDetector;

impl TaskDetector {
    pub fn is_dev_task(input: &str) -> bool {
        let lower = input.to_lowercase();

        let dev_keywords: &[&str] = &[
            "加",
            "添加",
            "实现",
            "开发",
            "写",
            "改",
            "修改",
            "修复",
            "重构",
            "创建",
            "新增",
            "增加",
            "删除",
            "移除",
            "更新",
            "优化",
            "调整",
            "设计",
            "部署",
            "集成",
            "测试",
            "add",
            "implement",
            "create",
            "fix",
            "refactor",
            "build",
            "develop",
            "write",
            "change",
            "update",
            "remove",
            "delete",
            "optimize",
            "adjust",
            "design",
            "deploy",
            "integrate",
            "test",
        ];

        let chat_patterns: &[&str] = &["你好", "hello", "谢谢", "什么是", "解释", "介绍一下"];

        let has_dev_keyword = dev_keywords.iter().any(|kw| lower.contains(kw));
        let is_chat = chat_patterns.iter().any(|p| lower.contains(p));

        has_dev_keyword && !is_chat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dev_task() {
        assert!(TaskDetector::is_dev_task("给项目加一个登录功能"));
        assert!(TaskDetector::is_dev_task("implement user authentication"));
        assert!(TaskDetector::is_dev_task("修复这个 bug"));
    }

    #[test]
    fn rejects_chat_task() {
        assert!(!TaskDetector::is_dev_task("你好"));
        assert!(!TaskDetector::is_dev_task("什么是 Rust"));
        assert!(!TaskDetector::is_dev_task("谢谢你"));
    }
}

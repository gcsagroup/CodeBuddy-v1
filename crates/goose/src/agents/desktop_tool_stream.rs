use futures::stream::{self, BoxStream};
use futures::StreamExt;
use std::collections::HashMap;

/// Desktop calls share focus, coordinates and input order. Other tools retain
/// concurrent execution; only this batch's desktop streams are polled in order.
pub(super) fn merge_tool_streams<T: Send + 'static>(
    streams: Vec<(String, BoxStream<'static, T>)>,
    desktop_request_ids: &[String],
) -> BoxStream<'static, (String, T)> {
    let mut desktop = HashMap::new();
    let mut concurrent: Vec<BoxStream<'static, (String, T)>> = Vec::new();
    for (id, stream) in streams {
        if desktop_request_ids.contains(&id) {
            desktop.insert(id, stream);
        } else {
            concurrent.push(stream.map(move |item| (id.clone(), item)).boxed());
        }
    }
    let ordered: Vec<_> = desktop_request_ids
        .iter()
        .filter_map(|id| {
            desktop.remove(id).map(|stream| {
                let id = id.clone();
                stream.map(move |item| (id.clone(), item)).boxed()
            })
        })
        .collect();
    if !ordered.is_empty() {
        concurrent.push(stream::iter(ordered).flatten().boxed());
    }
    stream::select_all(concurrent).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    #[tokio::test]
    async fn desktop_input_order_survives_async_preflight_and_other_tools_progress() {
        let executed = Arc::new(Mutex::new(Vec::new()));
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let first_log = executed.clone();
        let first = stream::once(async move {
            wait.await.unwrap();
            first_log.lock().unwrap().push("7");
            "7"
        })
        .boxed();
        let second_log = executed.clone();
        let second = stream::once(async move {
            second_log.lock().unwrap().push("3");
            "3"
        })
        .boxed();
        // Permission preparation may group streams differently from model order.
        let streams = vec![
            ("second".into(), second),
            ("search".into(), stream::once(async { "web" }).boxed()),
            ("first".into(), first),
        ];
        let mut merged = merge_tool_streams(streams, &["first".into(), "second".into()]);
        let item = tokio::time::timeout(Duration::from_secs(1), merged.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(item, ("search".into(), "web"));
        assert!(
            executed.lock().unwrap().is_empty(),
            "later input ran before first finished"
        );
        release.send(()).unwrap();
        let rest: Vec<_> = merged.collect().await;
        assert_eq!(rest, vec![("first".into(), "7"), ("second".into(), "3")]);
        assert_eq!(*executed.lock().unwrap(), vec!["7", "3"]);
    }
}

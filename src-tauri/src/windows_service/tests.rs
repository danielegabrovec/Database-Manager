use super::*;
use serde_json::json;
fn fixture() -> (tempfile::TempDir, String, NativeDistribution) {
    let temp = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4().to_string();
    let d = bundled_distributions().remove(0);
    let env = temp.path().join("environments").join(&id);
    fs::create_dir_all(env.join("data/empty-folder")).unwrap();
    fs::write(env.join(".dbm-owner"), &id).unwrap();
    fs::write(env.join("data/PG_VERSION"), "18").unwrap();
    let archive = url::Url::parse(&d.url)
        .unwrap()
        .path_segments()
        .unwrap()
        .next_back()
        .unwrap()
        .to_owned();
    fs::create_dir(temp.path().join("native-downloads")).unwrap();
    fs::write(
        temp.path().join("native-downloads").join(archive),
        b"not an approved archive",
    )
    .unwrap();
    fs::write(temp.path().join("environment-registry.json"),serde_json::to_vec(&json!({"environments":[{"id":id,"name":"Test managed","engine":"postgresql","provider":"native","laboratory":false,"version":d.version,"distributionId":d.id,"imageDigest":null,"endpoint":"postgresql://127.0.0.1:55111","port":55111,"username":"dbm_admin","status":"stopped","createdAt":"2026-11-09T00:00:00Z","lastError":null,"resourceNote":"test","initialized":true}],"distributions":[{"id":d.id,"sha256":"attacker-controlled"}]})).unwrap()).unwrap();
    (temp, id, d)
}
#[test]
fn planning_is_read_only_and_uses_static_catalog() {
    let (temp, id, d) = fixture();
    let target = temp.path().join("Services");
    let plan = plan_with_base(temp.path(), &id, &target, |_| Ok(None)).unwrap();
    assert_eq!(plan.archive_sha256, d.sha256);
    assert_eq!(plan.account, format!("NT SERVICE\\DBM-{id}"));
    assert_eq!(plan.actions, vec!["install"]);
    assert!(!target.exists());
    assert!(!plan.installed);
    assert!(!plan.live_scm_certified);
}
#[test]
fn denies_laboratory_external_provider_and_bad_marker() {
    for (field, value) in [("laboratory", json!(true)), ("provider", json!("existing"))] {
        let (temp, id, _) = fixture();
        let file = temp.path().join("environment-registry.json");
        let mut value_json: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        value_json["environments"][0][field] = value;
        fs::write(file, serde_json::to_vec(&value_json).unwrap()).unwrap();
        assert!(source(temp.path(), &id).is_err());
    }
    let (temp, id, _) = fixture();
    fs::write(
        temp.path()
            .join("environments")
            .join(&id)
            .join(".dbm-owner"),
        Uuid::new_v4().to_string(),
    )
    .unwrap();
    assert!(source(temp.path(), &id).is_err());
}
#[test]
fn rejects_noncanonical_identifiers_and_shell_actions() {
    for id in ["../windows", "DBM-test", "00000000000000000000000000000000"] {
        assert!(service_name(id).is_err());
    }
    for action in ["restart;cmd", "purge", "powershell", "install --anything"] {
        assert!(Action::parse(action).is_err());
    }
}
#[test]
fn archive_hash_is_checked_before_extraction() {
    let d = bundled_distributions().remove(0);
    assert!(verify_archive(&mut std::io::Cursor::new(b"attacker bytes"), &d.sha256).is_err());
    let expected = format!("{:x}", Sha256::digest(b"payload"));
    verify_archive(&mut std::io::Cursor::new(b"payload"), &expected).unwrap();
}
#[test]
fn argv_encoding_quotes_spaces_quotes_and_trailing_backslashes() {
    assert_eq!(
        quote_arg(r#"C:\Program Files\Database Manager\"#),
        "\"C:\\Program Files\\Database Manager\\\\\""
    );
    assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
    assert!(!command_line(
        Path::new("C:/runtime/server.exe"),
        &["--config=C:/path with spaces/server.ini".into()]
    )
    .contains("cmd.exe"));
}
#[test]
fn cold_copy_preserves_empty_directories_and_never_changes_source() {
    let (temp, id, _) = fixture();
    let root = temp.path().join("environments").join(id);
    let pinned = PinnedTree::open(&root).unwrap();
    let copy = temp.path().join("copied");
    fs::create_dir(&copy).unwrap();
    pinned.copy_data(&copy).unwrap();
    assert!(copy.join("empty-folder").is_dir());
    assert_eq!(fs::read(copy.join("PG_VERSION")).unwrap(), b"18");
    assert_eq!(fs::read(root.join("data/PG_VERSION")).unwrap(), b"18");
}
#[test]
fn elevated_copy_rejects_hardlinked_files() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("data")).unwrap();
    fs::write(temp.path().join("private"), b"private").unwrap();
    fs::hard_link(temp.path().join("private"), temp.path().join("data/link")).unwrap();
    assert!(PinnedTree::open(temp.path()).is_err());
}

fn manifest() -> Manifest {
    let id = Uuid::new_v4().to_string();
    Manifest{format:FORMAT,environment_id:id.clone(),engine:Engine::Postgresql,service_name:format!("DBM-{id}"),account:format!("NT SERVICE\\DBM-{id}"),distribution_id:"postgresql-18-6".into(),archive_sha256:"a".repeat(64),port:55111,binary_relative:PathBuf::from("pgsql/bin/pg_ctl.exe"),arguments:vec!["runservice".into()],image_path:"\"C:\\ProgramData\\DatabaseManager\\Services\\owned\\runtime\\pg_ctl.exe\" \"runservice\"".into(),source_root:PathBuf::from("source")}
}
fn snapshot_of(m: &Manifest) -> Snapshot {
    Snapshot {
        image_path: m.image_path.clone(),
        account: m.account.clone(),
        description: marker(m),
        state: "stopped".into(),
        service_type: 0x10,
    }
}
#[derive(Default)]
struct MockScm {
    snapshot: Option<Snapshot>,
    calls: Vec<String>,
    queries: usize,
    change_after_stop: bool,
}
impl Scm for MockScm {
    fn query(&mut self, _: &str) -> Result<Option<Snapshot>> {
        self.queries += 1;
        if self.change_after_stop && !self.calls.is_empty() {
            if let Some(s) = &mut self.snapshot {
                s.image_path = "C:\\unrelated-server.exe".into();
            }
        }
        Ok(self.snapshot.clone())
    }
    fn install(&mut self, _: &Manifest) -> Result<()> {
        self.calls.push("install".into());
        Ok(())
    }
    fn start(&mut self, _: &str) -> Result<()> {
        self.calls.push("start".into());
        self.snapshot.as_mut().unwrap().state = "running".into();
        Ok(())
    }
    fn stop(&mut self, _: &str) -> Result<()> {
        self.calls.push("stop".into());
        self.snapshot.as_mut().unwrap().state = "stopped".into();
        Ok(())
    }
    fn remove(&mut self, _: &str) -> Result<()> {
        self.calls.push("remove".into());
        self.snapshot = None;
        Ok(())
    }
}
#[test]
fn scm_controls_reject_foreign_paths_accounts_and_markers() {
    let m = manifest();
    for mutation in 0..3 {
        let mut state = snapshot_of(&m);
        match mutation {
            0 => state.image_path = "C:\\external.exe".into(),
            1 => state.account = "LocalSystem".into(),
            _ => state.description = "external".into(),
        };
        let mut mock = MockScm {
            snapshot: Some(state),
            ..Default::default()
        };
        assert!(control(&m, Action::Remove, &mut mock).is_err());
        assert!(mock.calls.is_empty());
    }
}
#[test]
fn removal_checks_scm_identity_again_after_stop() {
    let m = manifest();
    let mut mock = MockScm {
        snapshot: Some(snapshot_of(&m)),
        change_after_stop: true,
        ..Default::default()
    };
    assert!(control(&m, Action::Remove, &mut mock).is_err());
    assert_eq!(mock.calls, vec!["stop"]);
}
#[test]
fn dry_run_controls_use_only_enumerated_operations() {
    let m = manifest();
    let mut mock = MockScm {
        snapshot: Some(snapshot_of(&m)),
        ..Default::default()
    };
    assert_eq!(control(&m, Action::Start, &mut mock).unwrap(), "running");
    assert_eq!(control(&m, Action::Stop, &mut mock).unwrap(), "stopped");
    assert_eq!(control(&m, Action::Remove, &mut mock).unwrap(), "removed");
    assert_eq!(mock.calls, vec!["start", "stop", "stop", "remove"]);
}
#[test]
fn collision_never_mutates_existing_service_or_programdata() {
    let (temp, id, _) = fixture();
    let plan = plan_with_base(temp.path(), &id, &temp.path().join("Services"), |_| {
        Ok(None)
    })
    .unwrap();
    let pinned = PinnedTree::open(&temp.path().join("environments").join(&id)).unwrap();
    let existing = manifest();
    let mut mock = MockScm {
        snapshot: Some(snapshot_of(&existing)),
        ..Default::default()
    };
    assert!(execute(&plan, Action::Install, &pinned, &mut mock).is_err());
    assert!(mock.calls.is_empty());
    assert!(!plan.service_root.exists());
}
#[test]
fn malformed_helper_and_archive_traversal_have_no_side_effects() {
    assert!(run_helper(&["unrelated".into()]).is_none());
    assert!(run_helper(&["--dbm-service-helper".into()])
        .unwrap()
        .is_err());
    let temp = tempfile::tempdir().unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("../escape", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"blocked").unwrap();
    let reader = zip.finish().unwrap();
    assert!(extract_archive(reader, &temp.path().join("runtime")).is_err());
    assert!(!temp.path().join("escape").exists());
}

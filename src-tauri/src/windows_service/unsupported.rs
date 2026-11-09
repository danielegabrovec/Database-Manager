use super::*;
fn unavailable<T>() -> Result<T> {
    Err("I servizi Windows sono disponibili soltanto su Windows.".into())
}
pub(super) fn services_base() -> Result<PathBuf> {
    unavailable()
}
pub(super) fn operations_base() -> Result<PathBuf> {
    unavailable()
}
pub(super) fn prepare_operations() -> Result<PathBuf> {
    unavailable()
}
pub(super) fn prepare_private_data(_root: &Path) -> Result<()> {
    unavailable()
}
pub(super) fn prepare_root(_root: &Path) -> Result<()> {
    unavailable()
}
pub(super) fn validate_service_root(_root: &Path) -> Result<()> {
    unavailable()
}
pub(super) fn secure_tree(_root: &Path, _sid: &str, _data: bool) -> Result<()> {
    unavailable()
}
pub(super) fn service_sid(_account: &str) -> Result<String> {
    unavailable()
}
pub(super) fn require_elevated() -> Result<()> {
    unavailable()
}
pub(super) fn elevate(_executable: &Path, _args: &[String]) -> Result<()> {
    unavailable()
}
pub(super) fn query(_name: &str) -> Result<Option<Snapshot>> {
    unavailable()
}
pub(super) fn open_locked(path: &Path, _directory: bool) -> Result<File> {
    reject_link(path)?;
    File::open(path).map_err(fail)
}
pub(super) fn reject_hardlink(file: &File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(fail)?.nlink() != 1 {
            return Err("Hard link non ammesso.".into());
        }
    }
    Ok(())
}
pub(super) struct NativeScm;
impl Scm for NativeScm {
    fn query(&mut self, _: &str) -> Result<Option<Snapshot>> {
        unavailable()
    }
    fn install(&mut self, _: &Manifest) -> Result<()> {
        unavailable()
    }
    fn start(&mut self, _: &str) -> Result<()> {
        unavailable()
    }
    fn stop(&mut self, _: &str) -> Result<()> {
        unavailable()
    }
    fn remove(&mut self, _: &str) -> Result<()> {
        unavailable()
    }
}

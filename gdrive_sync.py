#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import glob
from datetime import datetime

DB_PATH = "/home/ayush/workbench_hub/workbench.db"
BACKUP_DIR = "/home/ayush/workbench_hub/backups"
NOTES_DIR = "/home/ayush/workbench_hub/notes"
RCLONE_DEST = "gdrive_backup:workbench_backups/"
RETENTION_DAYS = 7

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

def main():
    log("Starting Workbench Hub backup...")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    os.makedirs(NOTES_DIR, exist_ok=True)
    
    snap_db = os.path.join(BACKUP_DIR, "workbench_snap.db")
    
    # 1. Safely dump SQLite database to avoid locking
    if os.path.exists(DB_PATH):
        log(f"Backing up SQLite database {DB_PATH} to {snap_db}...")
        backup_cmd = f"sqlite3 {DB_PATH} \".backup '{snap_db}'\""
        res = subprocess.run(backup_cmd, shell=True, capture_output=True, text=True)
        if res.returncode != 0:
            log(f"ERROR: SQLite backup failed: {res.stderr}")
        else:
            log("SQLite snapshot created successfully.")
    else:
        log(f"WARNING: Database {DB_PATH} does not exist yet. Creating empty placeholder.")
        subprocess.run(f"sqlite3 {snap_db} 'VACUUM;'", shell=True)

    # 2. Bundle workbench_snap.db and notes/ into backup tarball
    now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_name = f"backup_{now_str}.tar.gz"
    archive_path = os.path.join(BACKUP_DIR, archive_name)
    
    log(f"Creating archive {archive_path}...")
    tar_cmd = f"tar -czf {archive_path} -C {BACKUP_DIR} workbench_snap.db -C /home/ayush/workbench_hub notes"
    res = subprocess.run(tar_cmd, shell=True, capture_output=True, text=True)
    if res.returncode != 0:
        log(f"ERROR creating tar archive: {res.stderr}")
        sys.exit(1)
    log(f"Archive created successfully: {archive_path} ({os.path.getsize(archive_path)} bytes)")

    # 3. Invoke rclone copy to push archive to Google Drive
    log(f"Pushing {archive_path} to {RCLONE_DEST} via rclone...")
    rclone_cmd = f"rclone copy {archive_path} {RCLONE_DEST}"
    try:
        res = subprocess.run(rclone_cmd, shell=True, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        log("WARNING: rclone copy timed out after 60 seconds.")
        res = subprocess.CompletedProcess(args=rclone_cmd, returncode=124, stdout="", stderr="TimeoutExpired")
    if res.returncode != 0:
        log(f"WARNING: rclone copy failed (remote 'gdrive_backup' may require configuration): {res.stderr.strip()}")
    else:
        log("Rclone sync completed successfully.")

    # 4. Automatically prune local backup tarballs older than 7 days
    log(f"Pruning local backups older than {RETENTION_DAYS} days...")
    now = time.time()
    cutoff = now - (RETENTION_DAYS * 86400)
    for f in glob.glob(os.path.join(BACKUP_DIR, "backup_*.tar.gz")):
        try:
            mtime = os.path.getmtime(f)
            if mtime < cutoff:
                os.remove(f)
                log(f"Pruned old backup: {f}")
        except Exception as e:
            log(f"Error checking/pruning {f}: {e}")

    log("Backup pipeline finished.")

if __name__ == "__main__":
    main()

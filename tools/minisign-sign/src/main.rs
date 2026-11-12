//! Litet verktyg så att varken du eller bygget behöver installera minisign.
//!
//!   minisign-sign generate [mapp]     → skriver minisign.key (hemlig), minisign.password och minisign.pub (publik)
//!   minisign-sign sign <fil>          → skriver <fil>.minisig
//!   minisign-sign verify <fil> <pub>  → kontrollerar <fil> mot <fil>.minisig och minisign.pub
//!
//! Hemlig nyckel vid signering: miljövariabeln MINISIGN_KEY (hela filens text).
//! Lösenordet till nyckeln anges alltid i MINISIGN_PASSWORD (vid `generate` blir det nyckelns
//! nya lösenord, vid `sign` används det för att låsa upp den).

use minisign::{sign, verify, KeyPair, PublicKeyBox, SecretKeyBox, SignatureBox};
use std::io::BufReader;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let password = std::env::var("MINISIGN_PASSWORD").ok().filter(|p| !p.is_empty());
    match args.first().map(String::as_str) {
        Some("generate") => {
            // Valfri målmapp som andra argument. Lösenord: MINISIGN_PASSWORD om satt, annars skapas
            // ett slumpmässigt som sparas i minisign.password (lässbar bara av dig) och aldrig skrivs ut.
            let dir = std::path::PathBuf::from(args.get(1).map(String::as_str).unwrap_or("."));
            std::fs::create_dir_all(&dir)?;
            let (password, generated) = match password {
                Some(p) => (p, false),
                None => (random_password()?, true),
            };
            let kp = KeyPair::generate_encrypted_keypair(Some(password.clone()))?;
            let pk_text = kp.pk.to_box()?.to_string();
            write_private(&dir.join("minisign.key"), &kp.sk.to_box(Some("Transkribera"))?.to_string())?;
            std::fs::write(dir.join("minisign.pub"), &pk_text)?;
            if generated {
                write_private(&dir.join("minisign.password"), &password)?;
            }
            let b64 = pk_text.lines().last().unwrap_or("").trim();
            println!("Klart. Filer i {}: minisign.key (HEMLIG){}, minisign.pub.", dir.display(),
                if generated { ", minisign.password (HEMLIG)" } else { "" });
            println!("Publik nyckel att klistra in i updater.rs (PUBLIC_KEY):\n{b64}");
        }
        Some("sign") => {
            let file = args.get(1).ok_or("ange fil att signera")?;
            let key_text = std::env::var("MINISIGN_KEY").map_err(|_| "MINISIGN_KEY saknas")?;
            let password = password.ok_or("MINISIGN_PASSWORD saknas")?;
            let sk = SecretKeyBox::from_string(&key_text)?.into_secret_key(Some(password))?;
            let reader = BufReader::new(std::fs::File::open(file)?);
            let name = std::path::Path::new(file).file_name().and_then(|n| n.to_str()).unwrap_or("fil");
            let sig = sign(None::<&minisign::PublicKey>, &sk, reader, Some(&format!("file:{name}")), Some("Transkribera"))?;
            std::fs::write(format!("{file}.minisig"), sig.to_string())?;
            println!("Skapade {file}.minisig");
        }
        Some("verify") => {
            let file = args.get(1).ok_or("ange fil")?;
            let pub_file = args.get(2).ok_or("ange publik nyckelfil")?;
            let pk = PublicKeyBox::from_string(&std::fs::read_to_string(pub_file)?)?.into_public_key()?;
            let sig = SignatureBox::from_string(&std::fs::read_to_string(format!("{file}.minisig"))?)?;
            verify(&pk, &sig, BufReader::new(std::fs::File::open(file)?), true, false, false)?;
            println!("Signaturen stämmer.");
        }
        _ => {
            eprintln!("Användning: minisign-sign generate | sign <fil> | verify <fil> <pub>");
            std::process::exit(2);
        }
    }
    Ok(())
}

/// 32 slumpmässiga tecken (a–z, A–Z, 0–9) ur operativsystemets slumptalskälla.
fn random_password() -> Result<String, Box<dyn std::error::Error>> {
    use std::io::Read;
    const ABC: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut f = std::fs::File::open("/dev/urandom")?;
    let mut out = String::new();
    let mut b = [0u8; 1];
    while out.len() < 32 {
        f.read_exact(&mut b)?;
        // 248 = största multipel av 62 under 256 → ingen snedfördelning
        if b[0] < 248 {
            out.push(ABC[(b[0] % 62) as usize] as char);
        }
    }
    Ok(out)
}

/// Skriver en hemlig fil som bara ägaren får läsa (0600 på Unix).
fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    let mut f = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?
    };
    #[cfg(not(unix))]
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(text.as_bytes())
}

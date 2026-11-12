//! Litet verktyg så att varken du eller bygget behöver installera minisign.
//!
//!   minisign-sign generate            → skriver minisign.key (hemlig) och minisign.pub (publik)
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
            let password = password.ok_or("Sätt MINISIGN_PASSWORD (lösenord för den hemliga nyckeln) först")?;
            let kp = KeyPair::generate_encrypted_keypair(Some(password))?;
            let pk_text = kp.pk.to_box()?.to_string();
            std::fs::write("minisign.key", kp.sk.to_box(Some("Transkribera"))?.to_string())?;
            std::fs::write("minisign.pub", &pk_text)?;
            let b64 = pk_text.lines().last().unwrap_or("").trim();
            println!("Klart. Filer: minisign.key (HEMLIG, lägg i GitHub Secrets) och minisign.pub.");
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

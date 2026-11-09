use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exercise {
    pub id: String,
    pub title: String,
    pub description: String,
    pub query: String,
    pub hints: Vec<String>,
    pub difficulty: String,
    #[serde(skip)]
    pub check: Option<String>,
}
pub fn exercises(engine: &str, dataset: &str) -> Vec<Exercise> {
    let e = |id: &str,
             title: &str,
             description: &str,
             query: &str,
             hints: &[&str],
             difficulty: &str,
             check: Option<&str>| Exercise {
        id: id.into(),
        title: title.into(),
        description: description.into(),
        query: query.into(),
        hints: hints.iter().map(|s| s.to_string()).collect(),
        difficulty: difficulty.into(),
        check: check.map(str::to_owned),
    };
    if engine == "mongodb" {
        let collection = if dataset == "library" {
            "books"
        } else {
            "customers"
        };
        return vec![
 e("mongo-find","Leggi i documenti","Restituisci tutti i documenti della collezione.",&serde_json::json!({"find":collection,"filter":{},"limit":20}).to_string(),&["Il campo find identifica la collezione.","Un filtro vuoto seleziona tutti i documenti."],"Base",None),
 e("mongo-count","Conta i documenti","Usa una pipeline per contare i documenti.",&serde_json::json!({"aggregate":collection,"pipeline":[{"$count":"totale"}],"cursor":{}}).to_string(),&["aggregate esegue una sequenza di stadi.","$count produce un documento con il conteggio."],"Base",None),
 e("mongo-project","Proietta due campi","Restituisci un campo descrittivo escludendo _id.",&serde_json::json!({"find":collection,"filter":{},"projection":{"_id":0,if dataset=="library"{"title"}else{"name"}:1}}).to_string(),&["projection sceglie i campi.","_id si esclude esplicitamente con 0."],"Intermedio",None),
 ];
    }
    let quote = |n: &str| crate::models::quote_ident(engine, n);
    let (table, field) = match dataset {
        "library" => ("books", "title"),
        "inventory" => ("products", "name"),
        "company" => ("employees", "name"),
        _ => ("customers", "name"),
    };
    let mut out = vec![
        e(
            "list",
            "Leggi i record",
            "Restituisci tutti i record ordinati per id.",
            &format!("SELECT * FROM {} ORDER BY id;", quote(table)),
            &[
                "SELECT sceglie le colonne, FROM la tabella.",
                "ORDER BY id rende l'ordine deterministico.",
            ],
            "Base",
            None,
        ),
        e(
            "count",
            "Conta i record",
            "Restituisci il numero di record con alias totale.",
            &format!("SELECT COUNT(*) AS totale FROM {};", quote(table)),
            &[
                "COUNT(*) include anche righe che contengono NULL.",
                "AS assegna un nome alla colonna di risultato.",
            ],
            "Base",
            None,
        ),
        e(
            "projection",
            "Scegli le colonne",
            "Restituisci soltanto id e il campo descrittivo.",
            &format!(
                "SELECT id, {} FROM {} ORDER BY id;",
                quote(field),
                quote(table)
            ),
            &[
                "Elenca le colonne separate da virgole.",
                "Evita SELECT * quando ti servono pochi campi.",
            ],
            "Base",
            None,
        ),
    ];
    match dataset {
        "shop" | "clienti" | "orders" => {
            out.push(e(
                "filter",
                "Filtra per città",
                "Restituisci id e nome dei clienti di Udine.",
                "SELECT id,name FROM customers WHERE city = 'Udine' ORDER BY id;",
                &[
                    "WHERE filtra le righe prima del risultato.",
                    "I valori testuali sono racchiusi da apici singoli.",
                ],
                "Base",
                None,
            ));
            out.push(e("join","Collega ordini e clienti","Restituisci id ordine, nome cliente e stato.","SELECT o.id,c.name,o.status FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id;",&["JOIN collega le tabelle tramite chiave esterna.","Usa alias diversi per identificare le colonne."],"Intermedio",None));
            out.push(e("aggregate","Totale per cliente","Restituisci nome cliente e totale acquistato, ordinato per cliente.","SELECT c.name,SUM(i.quantity*i.unit_price) AS total FROM customers c JOIN orders o ON o.customer_id=c.id JOIN order_items i ON i.order_id=o.id GROUP BY c.id,c.name ORDER BY c.id;",&["SUM aggrega i valori del gruppo.","GROUP BY raggruppa le righe dello stesso cliente."],"Intermedio",None));
            out.push(e(
                "null",
                "Trova i valori mancanti",
                "Restituisci id e nome dei clienti senza email.",
                "SELECT id,name FROM customers WHERE email IS NULL ORDER BY id;",
                &[
                    "NULL rappresenta assenza di valore.",
                    "Usa IS NULL, non = NULL.",
                ],
                "Base",
                None,
            ));
            if engine == "sqlite" {
                out.push(e(
                    "update",
                    "Modifica una giacenza",
                    "Riduci di uno lo stock del prodotto id=1.",
                    "UPDATE products SET stock=stock-1 WHERE id=1;",
                    &[
                        "UPDATE modifica righe esistenti.",
                        "WHERE limita la modifica al record desiderato.",
                    ],
                    "Intermedio",
                    Some("SELECT stock FROM products WHERE id=1;"),
                ));
                out.push(e(
                    "transaction",
                    "Prova un rollback",
                    "Modifica lo stock del prodotto 1 in una transazione e annulla.",
                    "BEGIN; UPDATE products SET stock=0 WHERE id=1; ROLLBACK;",
                    &[
                        "BEGIN apre una transazione.",
                        "ROLLBACK annulla le modifiche della transazione.",
                    ],
                    "Avanzato",
                    Some("SELECT stock FROM products WHERE id=1;"),
                ));
            }
        }
        "library" | "biblioteca" => {
            out.push(e("join","Libri e autori","Restituisci titolo e autore dei libri.","SELECT b.title,a.name FROM books b JOIN authors a ON a.id=b.author_id ORDER BY b.id;",&["author_id collega books ad authors."],"Intermedio",None));
            out.push(e(
                "null",
                "Prestiti ancora aperti",
                "Trova i prestiti senza data di restituzione.",
                "SELECT id,reader FROM loans WHERE return_date IS NULL ORDER BY id;",
                &["Una data mancante si verifica con IS NULL."],
                "Base",
                None,
            ));
        }
        "company" => {
            out.push(e("group","Dipendenti per reparto","Restituisci il numero di dipendenti per reparto.","SELECT d.name,COUNT(e.id) AS total FROM departments d LEFT JOIN employees e ON e.department_id=d.id GROUP BY d.id,d.name ORDER BY d.id;",&["LEFT JOIN conserva anche i reparti vuoti.","COUNT(e.id) conta soltanto dipendenti presenti."],"Intermedio",None));
        }
        _ => {
            out.push(e("join","Disponibilità per magazzino","Collega prodotti e giacenze.","SELECT p.name,s.warehouse_id,s.quantity FROM products p JOIN stock s ON s.product_id=p.id ORDER BY p.id,s.warehouse_id;",&["La tabella stock ha una chiave primaria composta."],"Intermedio",None));
        }
    }
    out
}

pub fn seed_sql(dataset: &str) -> Result<&'static str, String> {
    match dataset {
        "shop" | "clienti" | "orders" => Ok(SHOP),
        "library" | "biblioteca" => Ok(LIBRARY),
        "inventory" | "magazzino" => Ok(INVENTORY),
        "company" => Ok(COMPANY),
        _ => Err("Dataset non riconosciuto: shop, library, inventory, company.".into()),
    }
}
pub fn seed(conn: &Connection, dataset: &str) -> Result<(), String> {
    conn.execute_batch(seed_sql(dataset)?)
        .map_err(|e| e.to_string())
}
const SHOP: &str = r#"
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, email TEXT UNIQUE);
CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC NOT NULL CHECK(price>=0), stock INTEGER NOT NULL DEFAULT 0);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), created_at TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE order_items(order_id INTEGER NOT NULL REFERENCES orders(id),product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>0),unit_price NUMERIC NOT NULL,PRIMARY KEY(order_id,product_id));
CREATE INDEX idx_orders_customer ON orders(customer_id);
INSERT INTO customers VALUES(1,'Anna Rossi','Udine','anna@example.test'),(2,'Marco Bianchi','Trieste','marco@example.test'),(3,'Sara Verdi','Udine',NULL),(4,'Luca D''Angelo','Pordenone','luca@example.test'),(5,'Elena Müller','Gorizia','elena@example.test');
INSERT INTO products VALUES(1,'Taccuino',8.50,30),(2,'Penna',2.75,100),(3,'Zaino',49.90,12),(4,'Borraccia',18.00,20),(5,'Lampada',35.50,0);
INSERT INTO orders VALUES(1,1,'2026-10-01','completed'),(2,2,'2026-10-03','completed'),(3,1,'2026-10-08','pending'),(4,3,'2026-10-10','completed'),(5,4,'2026-10-12','cancelled');
INSERT INTO order_items VALUES(1,1,2,8.50),(1,2,3,2.75),(2,3,1,49.90),(3,4,2,18.00),(4,1,1,8.50),(4,5,1,35.50),(5,2,10,2.75);
CREATE VIEW order_totals AS SELECT o.id,o.customer_id,o.status,SUM(i.quantity*i.unit_price) AS total FROM orders o JOIN order_items i ON i.order_id=o.id GROUP BY o.id,o.customer_id,o.status;
"#;
const LIBRARY: &str = r#"
CREATE TABLE authors(id INTEGER PRIMARY KEY,name TEXT NOT NULL,country TEXT);
CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT NOT NULL,author_id INTEGER REFERENCES authors(id),year INTEGER,copies INTEGER NOT NULL DEFAULT 1);
CREATE TABLE loans(id INTEGER PRIMARY KEY,book_id INTEGER REFERENCES books(id),reader TEXT NOT NULL,loan_date TEXT NOT NULL,return_date TEXT);
INSERT INTO authors VALUES(1,'Italo Calvino','Italia'),(2,'Virginia Woolf','Regno Unito'),(3,'Primo Levi','Italia');
INSERT INTO books VALUES(1,'Il barone rampante',1,1957,3),(2,'Le città invisibili',1,1972,2),(3,'Una stanza tutta per sé',2,1929,2),(4,'Il sistema periodico',3,1975,1);
INSERT INTO loans VALUES(1,1,'Anna','2026-10-01','2026-10-12'),(2,3,'Marco','2026-10-05',NULL),(3,2,'Sara','2026-10-08',NULL);
CREATE INDEX idx_loans_book ON loans(book_id);
"#;
const INVENTORY: &str = r#"
CREATE TABLE warehouses(id INTEGER PRIMARY KEY,name TEXT NOT NULL,city TEXT);
CREATE TABLE products(id INTEGER PRIMARY KEY,sku TEXT UNIQUE NOT NULL,name TEXT NOT NULL,price NUMERIC NOT NULL);
CREATE TABLE stock(warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>=0),PRIMARY KEY(warehouse_id,product_id));
INSERT INTO warehouses VALUES(1,'Centrale','Udine'),(2,'Filiale','Trieste');
INSERT INTO products VALUES(1,'A001','Monitor',249.90),(2,'A002','Tastiera',59.50),(3,'A003','Mouse',24.90);
INSERT INTO stock VALUES(1,1,12),(1,2,30),(1,3,50),(2,1,5),(2,2,8),(2,3,0);
"#;
const COMPANY: &str = r#"
CREATE TABLE departments(id INTEGER PRIMARY KEY,name TEXT NOT NULL,budget NUMERIC NOT NULL);
CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT NOT NULL,department_id INTEGER REFERENCES departments(id),salary NUMERIC,manager_id INTEGER REFERENCES employees(id));
INSERT INTO departments VALUES(1,'Sviluppo',250000),(2,'Design',100000),(3,'Vendite',150000);
INSERT INTO employees VALUES(1,'Anna',1,42000,NULL),(2,'Marco',1,35000,1),(3,'Sara',2,38000,NULL),(4,'Luca',3,32000,NULL),(5,'Elena',1,NULL,1);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_fixtures_enforce_relations() {
        for d in ["shop", "library", "inventory", "company"] {
            let c = Connection::open_in_memory().unwrap();
            c.pragma_update(None, "foreign_keys", true).unwrap();
            seed(&c, d).unwrap();
            let violations: u64 = c
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(violations, 0);
        }
    }
}
